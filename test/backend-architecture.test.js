const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { WatchRoom } = require('../src/watch-room');
const { RoomCoordinator } = require('../src/room-coordinator');

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fakeIo() {
  return {
    events: [],
    emit(event, payload) { this.events.push({ event, payload }); },
  };
}

test('server entrypoint stays composition-only instead of regrowing room/media logic', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.ok(Buffer.byteLength(source, 'utf8') < 8000);
  assert.match(source, /new MediaService\(settings\)/);
  assert.match(source, /new RoomCoordinator\(/);
  assert.match(source, /registerHttpRoutes\(/);
  assert.match(source, /registerSocketGateway\(/);
  assert.doesNotMatch(source, /io\.on\('connection'/);
  assert.doesNotMatch(source, /app\.get\('\/api\/library'/);
  assert.doesNotMatch(source, /playableCache/);
});

test('room coordinator enforces the configured participant limit', () => {
  const coordinator = new RoomCoordinator({ io: fakeIo(), room: new WatchRoom(), maxParticipants: 2 });
  assert.equal(coordinator.registerParticipant('a', 'A', 'socket-a'), true);
  assert.equal(coordinator.registerParticipant('a', 'A', 'socket-a2'), true);
  assert.equal(coordinator.registerParticipant('b', 'B', 'socket-b'), true);
  assert.equal(coordinator.registerParticipant('c', 'C', 'socket-c'), false);
  assert.equal(coordinator.participantList().length, 2);
  coordinator.stop();
});

test('sustained buffering enters a barrier and resumes only after both viewers are ready', async () => {
  const io = fakeIo();
  const room = new WatchRoom();
  const selected = room.apply('select', { mediaPath: 'movie.mp4' }, 'A');
  room.apply('play', {
    mediaPath: 'movie.mp4',
    mediaVersion: selected.mediaVersion,
    position: 12,
  }, 'A');

  const coordinator = new RoomCoordinator({
    io,
    room,
    maxParticipants: 2,
    bufferingDelayMs: 20,
    startDelayMs: 30,
  });
  coordinator.registerParticipant('a', 'A', 'socket-a');
  coordinator.registerParticipant('b', 'B', 'socket-b');

  coordinator.setBuffering('b', 'socket-b', true);
  await delay(45);
  const prepared = room.snapshot();
  assert.equal(prepared.playing, false);
  assert.equal(prepared.reason, 'barrier-buffering');
  assert.ok(coordinator.barrier);
  assert.ok(io.events.some((item) => item.event === 'room:barrier' && item.payload?.phase === 'preparing'));

  const barrierId = coordinator.barrier.id;
  coordinator.setBuffering('b', 'socket-b', false);
  assert.equal(coordinator.markReady('a', 'socket-a', { barrierId, mediaVersion: selected.mediaVersion }), true);
  assert.equal(room.snapshot().playing, false);
  assert.equal(coordinator.markReady('b', 'socket-b', { barrierId, mediaVersion: selected.mediaVersion }), true);

  const released = room.snapshot();
  assert.equal(released.playing, true);
  assert.equal(released.reason, 'barrier-release');
  assert.ok(released.startAt > released.serverNow);
  assert.ok(io.events.some((item) => item.event === 'room:barrier' && item.payload?.phase === 'starting'));
  coordinator.stop();
});
