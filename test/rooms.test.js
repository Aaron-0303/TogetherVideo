const test = require('node:test');
const assert = require('node:assert/strict');
const { RoomManager, createRoomState, effectivePosition } = require('../src/rooms');

function createHarness() {
  const store = {
    data: { rooms: { ours: createRoomState() } },
    getRoom(code) { return this.data.rooms[code] || null; },
    setRoom(code, room) { this.data.rooms[code] = room; return Promise.resolve(); },
    save() { return Promise.resolve(); },
  };
  const events = [];
  const io = {
    to(room) {
      return { emit(name, payload) { events.push({ room, name, payload }); } };
    },
  };
  const manager = new RoomManager({ io, store, defaultRoom: 'ours', maxRoomUsers: 2 });
  const socket = { data: { room: 'ours', nickname: 'A' } };
  return { manager, store, socket, events };
}

test('effectivePosition advances only while the room is playing', () => {
  const room = createRoomState();
  room.position = 10;
  room.rate = 1.5;
  room.playing = false;
  assert.equal(effectivePosition(room, 5000), 10);
  room.playing = true;
  room.startedAt = 1000;
  assert.equal(effectivePosition(room, 3000), 13);
});

test('selecting media increments mediaVersion even when selecting the same path again', () => {
  const { manager, store, socket } = createHarness();
  manager.applyPlayer(socket, 'media', { mediaPath: 'show/ep1.mp4', mediaName: 'ep1' });
  assert.equal(store.data.rooms.ours.mediaVersion, 1);
  manager.applyPlayer(socket, 'media', { mediaPath: 'show/ep1.mp4', mediaName: 'ep1' });
  assert.equal(store.data.rooms.ours.mediaVersion, 2);
});

test('stale player events cannot pause or seek a newly selected media source', () => {
  const { manager, store, socket } = createHarness();
  manager.applyPlayer(socket, 'media', { mediaPath: 'show/ep1.mp4', mediaName: 'ep1' });
  const oldVersion = store.data.rooms.ours.mediaVersion;
  manager.applyPlayer(socket, 'play', {
    mediaPath: 'show/ep1.mp4', mediaVersion: oldVersion, position: 5,
  });
  assert.equal(store.data.rooms.ours.playing, true);

  manager.applyPlayer(socket, 'media', { mediaPath: 'show/ep2.mp4', mediaName: 'ep2' });
  const currentVersion = store.data.rooms.ours.mediaVersion;
  manager.applyPlayer(socket, 'play', {
    mediaPath: 'show/ep2.mp4', mediaVersion: currentVersion, position: 1,
  });
  assert.equal(store.data.rooms.ours.playing, true);

  manager.applyPlayer(socket, 'pause', {
    mediaPath: 'show/ep1.mp4', mediaVersion: oldVersion, position: 99,
  });
  manager.applyPlayer(socket, 'seek', {
    mediaPath: 'show/ep2.mp4', mediaVersion: oldVersion, position: 88,
  });

  assert.equal(store.data.rooms.ours.mediaPath, 'show/ep2.mp4');
  assert.equal(store.data.rooms.ours.mediaVersion, currentVersion);
  assert.equal(store.data.rooms.ours.playing, true);
  assert.equal(store.data.rooms.ours.position, 1);
});

test('player snapshots omit chat and member payloads unless explicitly requested', () => {
  const { manager, store } = createHarness();
  store.data.rooms.ours.messages = [{ id: '1', text: 'hello' }];
  manager.members.set('ours', new Map([['socket-1', { id: 'socket-1', nickname: 'A' }]]));

  const playerSnapshot = manager.snapshot('ours');
  assert.equal(Object.hasOwn(playerSnapshot, 'messages'), false);
  assert.equal(Object.hasOwn(playerSnapshot, 'members'), false);

  const joinSnapshot = manager.snapshot('ours', { includeMessages: true, includeMembers: true });
  assert.equal(joinSnapshot.messages.length, 1);
  assert.equal(joinSnapshot.members.length, 1);
});