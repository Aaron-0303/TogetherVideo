const crypto = require('crypto');

function cleanRoom(value, fallback = 'ours') {
  const room = String(value || fallback).trim().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40);
  return room || fallback;
}

function cleanName(value) {
  return String(value || '访客').trim().replace(/[<>]/g, '').slice(0, 20) || '访客';
}

function cleanText(value, max = 300) {
  return String(value || '').trim().slice(0, max);
}

function cleanMediaPath(value) {
  return cleanText(value, 1000).replace(/\\/g, '/').replace(/^\/+/, '');
}

function createRoomState() {
  return {
    mediaPath: '',
    mediaName: '',
    mediaVersion: 0,
    playing: false,
    position: 0,
    rate: 1,
    startedAt: 0,
    updatedAt: Date.now(),
    updatedBy: '',
    messages: [],
  };
}

function effectivePosition(room, now = Date.now()) {
  if (!room.playing || !room.startedAt) return Math.max(0, Number(room.position || 0));
  return Math.max(0, Number(room.position || 0) + Math.max(0, now - room.startedAt) / 1000 * Number(room.rate || 1));
}

class RoomManager {
  constructor({ io, store, defaultRoom, maxRoomUsers }) {
    this.io = io;
    this.store = store;
    this.defaultRoom = defaultRoom;
    this.maxRoomUsers = maxRoomUsers;
    this.members = new Map();
  }

  start() {
    for (const room of Object.values(this.store.data.rooms)) {
      if (!Number.isFinite(Number(room.mediaVersion))) room.mediaVersion = 0;
      if (room.playing) {
        room.position = effectivePosition(room, Math.min(Date.now(), Number(room.startedAt || 0) + 30000));
        room.playing = false;
        room.startedAt = 0;
      }
    }
    this.store.save();
    this.io.on('connection', (socket) => this.onConnection(socket));
    const timer = setInterval(() => this.checkpoint(), 30000);
    timer.unref?.();
  }

  checkpoint() {
    let dirty = false;
    const now = Date.now();
    for (const room of Object.values(this.store.data.rooms)) {
      if (!room.playing) continue;
      room.position = effectivePosition(room, now);
      room.startedAt = now;
      room.updatedAt = now;
      dirty = true;
    }
    if (dirty) this.store.save();
  }

  roomState(code) {
    let room = this.store.getRoom(code);
    if (!room) {
      room = createRoomState();
      this.store.data.rooms[code] = room;
    }
    if (!Number.isFinite(Number(room.mediaVersion))) room.mediaVersion = 0;
    return room;
  }

  memberList(code) {
    const room = this.members.get(code);
    return room ? [...room.values()].map((member) => ({ id: member.id, nickname: member.nickname })) : [];
  }

  snapshot(code, { includeMembers = false, includeMessages = false } = {}) {
    const room = this.roomState(code);
    const snapshot = {
      room: code,
      mediaPath: room.mediaPath,
      mediaName: room.mediaName,
      mediaVersion: Number(room.mediaVersion || 0),
      playing: Boolean(room.playing),
      position: effectivePosition(room),
      rate: Number(room.rate || 1),
      updatedBy: room.updatedBy || '',
      serverNow: Date.now(),
    };
    if (includeMembers) snapshot.members = this.memberList(code);
    if (includeMessages) snapshot.messages = Array.isArray(room.messages) ? room.messages.slice(-100) : [];
    return snapshot;
  }

  onConnection(socket) {
    socket.data.room = '';
    socket.data.nickname = cleanName(socket.request.session?.nickname);

    socket.on('room:join', (payload = {}, ack = () => {}) => {
      const code = cleanRoom(payload.room, this.defaultRoom);
      const nickname = cleanName(payload.nickname || socket.data.nickname);
      const existing = this.members.get(code) || new Map();
      if (this.maxRoomUsers > 0 && existing.size >= this.maxRoomUsers && !existing.has(socket.id)) {
        return ack({ ok: false, error: '房间已满' });
      }
      if (socket.data.room) this.leave(socket);
      socket.data.room = code;
      socket.data.nickname = nickname;
      socket.join(code);
      if (!this.members.has(code)) this.members.set(code, new Map());
      this.members.get(code).set(socket.id, { id: socket.id, nickname });
      const snapshot = this.snapshot(code, { includeMembers: true, includeMessages: true });
      socket.emit('room:snapshot', snapshot);
      this.io.to(code).emit('room:members', snapshot.members);
      ack({ ok: true, room: code });
    });

    socket.on('sync:request', () => {
      if (socket.data.room) socket.emit('player:state', this.snapshot(socket.data.room));
    });
    socket.on('player:media', (payload = {}) => this.applyPlayer(socket, 'media', payload));
    socket.on('player:play', (payload = {}) => this.applyPlayer(socket, 'play', payload));
    socket.on('player:pause', (payload = {}) => this.applyPlayer(socket, 'pause', payload));
    socket.on('player:seek', (payload = {}) => this.applyPlayer(socket, 'seek', payload));
    socket.on('player:rate', (payload = {}) => this.applyPlayer(socket, 'rate', payload));

    socket.on('chat:send', (payload = {}, ack = () => {}) => {
      const code = socket.data.room;
      if (!code) return ack({ ok: false });
      const text = cleanText(payload.text);
      if (!text) return ack({ ok: false });
      const room = this.roomState(code);
      const message = { id: crypto.randomUUID(), nickname: socket.data.nickname, text, at: Date.now() };
      if (!Array.isArray(room.messages)) room.messages = [];
      room.messages.push(message);
      room.messages = room.messages.slice(-100);
      room.updatedAt = Date.now();
      this.store.setRoom(code, room);
      this.io.to(code).emit('chat:message', message);
      ack({ ok: true });
    });

    socket.on('reaction:send', (payload = {}) => {
      const code = socket.data.room;
      if (!code) return;
      const emoji = cleanText(payload.emoji, 8);
      if (emoji) this.io.to(code).emit('reaction:show', { id: crypto.randomUUID(), emoji, nickname: socket.data.nickname });
    });

    socket.on('disconnect', () => this.leave(socket));
  }

  isCurrentMediaEvent(room, payload = {}) {
    const eventPath = cleanMediaPath(payload.mediaPath);
    const eventVersion = Number(payload.mediaVersion);
    if (!eventPath || eventPath !== room.mediaPath) return false;
    if (!Number.isFinite(eventVersion) || eventVersion !== Number(room.mediaVersion || 0)) return false;
    return true;
  }

  applyPlayer(socket, action, payload = {}) {
    const code = socket.data.room;
    if (!code) return;
    const room = this.roomState(code);
    const now = Date.now();
    const position = Number(payload.position);

    if (action === 'media') {
      const mediaPath = cleanMediaPath(payload.mediaPath);
      if (!mediaPath) return;
      room.mediaPath = mediaPath;
      room.mediaName = cleanText(payload.mediaName, 200) || mediaPath.split('/').pop();
      room.mediaVersion = Number(room.mediaVersion || 0) + 1;
      room.position = 0;
      room.playing = false;
      room.rate = 1;
      room.startedAt = 0;
    } else {
      // Delayed browser events from a previous source must never mutate the new episode.
      if (!this.isCurrentMediaEvent(room, payload)) return;

      if (action === 'play') {
        room.position = Number.isFinite(position) ? Math.max(0, position) : effectivePosition(room, now);
        room.playing = true;
        room.startedAt = now;
      } else if (action === 'pause') {
        room.position = Number.isFinite(position) ? Math.max(0, position) : effectivePosition(room, now);
        room.playing = false;
        room.startedAt = 0;
      } else if (action === 'seek') {
        if (!Number.isFinite(position)) return;
        room.position = Math.max(0, position);
        if (room.playing) room.startedAt = now;
      } else if (action === 'rate') {
        const rate = Number(payload.rate);
        if (!Number.isFinite(rate) || rate < 0.25 || rate > 4) return;
        room.position = effectivePosition(room, now);
        room.rate = rate;
        if (room.playing) room.startedAt = now;
      } else {
        return;
      }
    }

    room.updatedAt = now;
    room.updatedBy = socket.data.nickname;
    this.store.setRoom(code, room);
    this.io.to(code).emit('player:state', this.snapshot(code));
  }

  leave(socket) {
    const code = socket.data.room;
    if (!code) return;
    const room = this.members.get(code);
    room?.delete(socket.id);
    if (room?.size === 0) this.members.delete(code);
    socket.leave(code);
    socket.data.room = '';
    this.io.to(code).emit('room:members', this.memberList(code));
  }
}

module.exports = { RoomManager, cleanRoom, cleanName, cleanMediaPath, effectivePosition, createRoomState };