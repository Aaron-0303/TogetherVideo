const test = require('node:test');
const assert = require('node:assert/strict');
const { WatchRoom } = require('../src/watch-room');
const { RoomCoordinator } = require('../src/room-coordinator');
const { registerSocketGateway } = require('../src/socket-gateway');

class FakeIo {
  constructor() {
    this.handlers = new Map();
    this.events = [];
    this.middleware = null;
  }

  use(fn) { this.middleware = fn; }
  on(event, handler) { this.handlers.set(event, handler); }
  emit(event, payload) { this.events.push({ event, payload }); }
  connect(socket) { this.handlers.get('connection')(socket); }
}

class FakeSocket {
  constructor(id, participantId, nickname) {
    this.id = id;
    this.request = { session: { authenticated: true, participantId, nickname } };
    this.data = {};
    this.handlers = new Map();
    this.sent = [];
    this.disconnected = false;
  }

  on(event, handler) { this.handlers.set(event, handler); }
  emit(event, payload) { this.sent.push({ event, payload }); }
  trigger(event, payload) { return this.handlers.get(event)?.(payload); }
  disconnect() { this.disconnected = true; }
}

test('socket gateway turns play and seek into two-viewer readiness barriers', () => {
  const io = new FakeIo();
  const room = new WatchRoom();
  const coordinator = new RoomCoordinator({ io, room, maxParticipants: 2, startDelayMs: 50 });
  const mediaService = { isSupportedPath: (value) => String(value).endsWith('.mp4') };
  registerSocketGateway({ io, room, coordinator, mediaService });

  const a = new FakeSocket('socket-a', 'a', 'A');
  const b = new FakeSocket('socket-b', 'b', 'B');
  io.connect(a);
  io.connect(b);

  a.trigger('media:select', { mediaPath: 'movie.mp4', mediaName: 'movie.mp4' });
  const selected = room.snapshot();
  assert.equal(selected.media.path, 'movie.mp4');

  a.trigger('player:play', {
    mediaPath: 'movie.mp4',
    mediaVersion: selected.mediaVersion,
    position: 10,
  });
  assert.equal(room.snapshot().playing, false);
  assert.equal(room.snapshot().reason, 'barrier-play');
  assert.ok(coordinator.barrier);

  const playBarrier = coordinator.barrier.id;
  a.trigger('player:ready', { barrierId: playBarrier, mediaVersion: selected.mediaVersion });
  assert.equal(room.snapshot().playing, false);
  b.trigger('player:ready', { barrierId: playBarrier, mediaVersion: selected.mediaVersion });
  assert.equal(room.snapshot().playing, true);
  assert.equal(room.snapshot().reason, 'barrier-release');

  b.trigger('player:seek', {
    mediaPath: 'movie.mp4',
    mediaVersion: selected.mediaVersion,
    position: 42,
  });

  const seeking = room.snapshot();
  assert.equal(seeking.playing, false);
  assert.equal(seeking.reason, 'barrier-seek');
  assert.ok(Math.abs(seeking.position - 42) < 0.1);
  assert.ok(io.events.some((item) => (
    item.event === 'room:barrier'
    && item.payload?.phase === 'preparing'
    && item.payload?.reason === 'seek'
  )));
  coordinator.stop();
});

test('second viewer joining a running room pauses it into one broadcast join barrier', () => {
  const io = new FakeIo();
  const room = new WatchRoom();
  const coordinator = new RoomCoordinator({ io, room, maxParticipants: 2 });
  const mediaService = { isSupportedPath: (value) => String(value).endsWith('.mp4') };
  registerSocketGateway({ io, room, coordinator, mediaService });

  const a = new FakeSocket('socket-a', 'a', 'A');
  io.connect(a);
  a.trigger('media:select', { mediaPath: 'movie.mp4', mediaName: 'movie.mp4' });
  const selected = room.snapshot();
  room.apply('play', {
    mediaPath: 'movie.mp4',
    mediaVersion: selected.mediaVersion,
    position: 25,
  }, 'A');
  assert.equal(room.snapshot().playing, true);

  const b = new FakeSocket('socket-b', 'b', 'B');
  io.connect(b);
  assert.equal(room.snapshot().playing, false);
  assert.equal(room.snapshot().reason, 'barrier-join');
  assert.equal(coordinator.barrier?.reason, 'join');

  const joinBroadcasts = io.events.filter((item) => item.event === 'room:barrier' && item.payload?.reason === 'join');
  assert.equal(joinBroadcasts.length, 1);
  assert.equal(b.sent.some((item) => item.event === 'room:barrier' && item.payload?.reason === 'join'), false);
  coordinator.stop();
});

test('socket gateway rejects unsupported media selection before touching the room', () => {
  const io = new FakeIo();
  const room = new WatchRoom();
  const coordinator = new RoomCoordinator({ io, room, maxParticipants: 2 });
  const mediaService = { isSupportedPath: (value) => String(value).endsWith('.mp4') };
  registerSocketGateway({ io, room, coordinator, mediaService });

  const a = new FakeSocket('socket-a', 'a', 'A');
  io.connect(a);
  a.trigger('media:select', { mediaPath: 'notes.txt', mediaName: 'notes.txt' });
  assert.equal(room.snapshot().media, null);
  coordinator.stop();
});
