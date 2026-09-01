const test = require('node:test');
const assert = require('node:assert/strict');
const { WatchRoom } = require('../src/watch-room');
const { RoomCoordinator } = require('../src/room-coordinator');
const { registerSocketGateway, cleanChatMessage } = require('../src/socket-gateway');

class FakeIo {
  constructor() { this.handlers = new Map(); this.events = []; }
  use() {}
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
  }
  on(event, handler) { this.handlers.set(event, handler); }
  emit(event, payload) { this.sent.push({ event, payload }); }
  trigger(event, payload) { return this.handlers.get(event)?.(payload); }
  disconnect() {}
}

function createChatRoom() {
  const io = new FakeIo();
  const room = new WatchRoom();
  const coordinator = new RoomCoordinator({ io, room, maxParticipants: 2 });
  registerSocketGateway({
    io,
    room,
    coordinator,
    mediaService: { isSupportedPath: () => true },
  });
  return { io, room, coordinator };
}

test('room chat broadcasts messages and gives recent history to the second viewer', () => {
  const { io, coordinator } = createChatRoom();

  const a = new FakeSocket('socket-a', 'a', '旭旭');
  io.connect(a);
  a.trigger('chat:send', { text: '  一起 看 吧  ' });

  const broadcast = io.events.find((item) => item.event === 'chat:message');
  assert.ok(broadcast);
  assert.equal(broadcast.payload.participantId, 'a');
  assert.equal(broadcast.payload.nickname, '旭旭');
  assert.equal(broadcast.payload.text, '一起 看 吧');

  const b = new FakeSocket('socket-b', 'b', '小杨');
  io.connect(b);
  const history = b.sent.find((item) => item.event === 'chat:history');
  assert.ok(history);
  assert.equal(history.payload.length, 1);
  assert.equal(history.payload[0].text, '一起 看 吧');
  coordinator.stop();
});

test('clearing chat removes server history and notifies both viewers', () => {
  const { io, coordinator } = createChatRoom();

  const a = new FakeSocket('socket-a', 'a', '旭旭');
  const b = new FakeSocket('socket-b', 'b', '小杨');
  io.connect(a);
  io.connect(b);
  a.trigger('chat:send', { text: '这一条稍后删除' });

  io.events.length = 0;
  b.trigger('chat:clear');

  const cleared = io.events.find((item) => item.event === 'chat:cleared');
  assert.ok(cleared);
  assert.equal(cleared.payload.clearedBy, '小杨');

  const c = new FakeSocket('socket-c', 'c', '测试');
  coordinator.unregisterParticipant('a', 'socket-a');
  io.connect(c);
  const history = c.sent.find((item) => item.event === 'chat:history');
  assert.ok(history);
  assert.deepEqual(history.payload, []);
  coordinator.stop();
});

test('chat message cleaning rejects blank input and caps message length', () => {
  assert.equal(cleanChatMessage('   \n  '), '');
  assert.equal(cleanChatMessage('a'.repeat(400)).length, 300);
});
