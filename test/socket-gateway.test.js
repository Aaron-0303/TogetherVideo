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

test('play/pause remain synchronized while viewer buffering stays independent', () => {
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

  a.trigger('player:play', {
    mediaPath: 'movie.mp4',
    mediaVersion: selected.mediaVersion,
    position: 10,
  });
  assert.equal(room.snapshot().playing, true);
  assert.equal(room.snapshot().reason, 'play');
  assert.ok(room.snapshot().startAt > 0);

  a.trigger('presence:buffering', { buffering: true });
  assert.equal(room.snapshot().playing, true);
  assert.equal(room.snapshot().reason, 'play');

  b.trigger('player:pause', {
    mediaPath: 'movie.mp4',
    mediaVersion: selected.mediaVersion,
    position: 11,
  });
  assert.equal(room.snapshot().playing, false);
  assert.equal(room.snapshot().reason, 'pause');
  coordinator.stop();
});

test('seek behaves like both viewers manually dragging to one target without ready barrier', () => {
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
  a.trigger('player:play', { mediaPath: 'movie.mp4', mediaVersion: selected.mediaVersion, position: 5 });

  io.events.length = 0;
  b.trigger('player:seek', {
    mediaPath: 'movie.mp4',
    mediaVersion: selected.mediaVersion,
    position: 42,
  });

  const stateEvents = io.events.filter((item) => item.event === 'room:state');
  assert.ok(stateEvents.length >= 2);
  assert.equal(stateEvents.at(-2).payload.playing, false);
  assert.ok(Math.abs(stateEvents.at(-2).payload.position - 42) < 0.1);
  assert.equal(stateEvents.at(-1).payload.playing, true);
  assert.equal(stateEvents.at(-1).payload.reason, 'seek-resume');
  assert.ok(stateEvents.at(-1).payload.startAt > 0);
  assert.equal(io.events.some((item) => item.event === 'room:barrier'), false);
  coordinator.stop();
});

test('automatic drift reports never interrupt playback; manual resync performs one short re-alignment', () => {
  const io = new FakeIo();
  const room = new WatchRoom();
  const coordinator = new RoomCoordinator({ io, room, maxParticipants: 2, startDelayMs: 50 });
  const mediaService = { isSupportedPath: (value) => String(value).endsWith('.mp4') };
  registerSocketGateway({ io, room, coordinator, mediaService });

  const a = new FakeSocket('socket-a', 'a', 'A');
  io.connect(a);
  a.trigger('media:select', { mediaPath: 'movie.mp4', mediaName: 'movie.mp4' });
  const selected = room.snapshot();
  a.trigger('player:play', { mediaPath: 'movie.mp4', mediaVersion: selected.mediaVersion, position: 10 });

  const revisionBefore = room.snapshot().revision;
  a.trigger('player:desync', {
    mediaPath: 'movie.mp4', mediaVersion: selected.mediaVersion, position: 8, drift: -3,
  });
  assert.equal(room.snapshot().revision, revisionBefore);
  assert.equal(room.snapshot().playing, true);

  a.trigger('player:desync', {
    mediaPath: 'movie.mp4', mediaVersion: selected.mediaVersion, position: 8, drift: -3, manual: true,
  });
  assert.equal(room.snapshot().playing, true);
  assert.equal(room.snapshot().reason, 'resync');
  assert.ok(room.snapshot().startAt > 0);
  coordinator.stop();
});

test('second viewer joining a running room never pauses the first viewer', () => {
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

  const b = new FakeSocket('socket-b', 'b', 'B');
  io.connect(b);
  assert.equal(room.snapshot().playing, true);
  assert.notEqual(room.snapshot().reason, 'barrier-join');
  assert.equal(io.events.some((item) => item.event === 'room:barrier'), false);
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
