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
    this.broadcasted = [];
    this.disconnected = false;
    this.broadcast = {
      emit: (event, payload) => this.broadcasted.push({ event, payload }),
    };
  }

  on(event, handler) { this.handlers.set(event, handler); }
  emit(event, payload) { this.sent.push({ event, payload }); }
  trigger(event, payload) { return this.handlers.get(event)?.(payload); }
  disconnect() { this.disconnected = true; }
}

test('socket gateway sends seek ack to the actor and authoritative seek to the peer', () => {
  const io = new FakeIo();
  const room = new WatchRoom();
  const coordinator = new RoomCoordinator({ io, room, maxParticipants: 2 });
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
  assert.equal(room.snapshot().playing, true);

  b.trigger('player:seek', {
    mediaPath: 'movie.mp4',
    mediaVersion: selected.mediaVersion,
    position: 42,
  });

  const ack = b.sent.find((item) => item.event === 'room:state' && item.payload?.reason === 'seek-ack');
  const peer = b.broadcasted.find((item) => item.event === 'room:state' && item.payload?.reason === 'seek');
  assert.ok(ack);
  assert.ok(peer);
  assert.ok(Math.abs(room.snapshot().position - 42) < 0.1);
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
