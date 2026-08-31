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
  assert.doesNotMatch(source, /bufferingPauseTimer|playableCache/);
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

test('sustained buffering pauses and then resumes the authoritative room', async () => {
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
    pauseDelayMs: 20,
    resumeDelayMs: 20,
  });
  coordinator.registerParticipant('a', 'A', 'socket-a');
  coordinator.registerParticipant('b', 'B', 'socket-b');

  coordinator.setBuffering('b', 'socket-b', true);
  await delay(45);
  assert.equal(room.snapshot().playing, false);
  assert.equal(room.snapshot().reason, 'wait');
  assert.ok(io.events.some((item) => item.event === 'room:buffering-hold'));

  coordinator.setBuffering('b', 'socket-b', false);
  await delay(45);
  assert.equal(room.snapshot().playing, true);
  assert.equal(room.snapshot().reason, 'play');
  assert.ok(io.events.some((item) => item.event === 'room:buffering-resume'));
  coordinator.stop();
});
