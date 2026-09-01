const crypto = require('crypto');
const { cleanMediaPath } = require('./watch-room');
const { cleanName } = require('./identity');

const CHAT_HISTORY_LIMIT = 80;
const CHAT_MESSAGE_LIMIT = 300;

function cleanChatMessage(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, CHAT_MESSAGE_LIMIT);
}

function registerSocketGateway(options = {}) {
  const { io, room, coordinator, mediaService } = options;
  const chatHistory = [];

  io.use((socket, next) => (
    socket.request.session?.authenticated ? next() : next(new Error('unauthorized'))
  ));

  io.on('connection', (socket) => {
    const session = socket.request.session || {};
    const participantId = String(session.participantId || crypto.randomUUID());
    const nickname = cleanName(session.nickname);

    if (!coordinator.registerParticipant(participantId, nickname, socket.id)) {
      socket.emit('room:full', { message: `当前已有 ${coordinator.maxParticipants} 个人在线` });
      return setTimeout(() => socket.disconnect(true), 100);
    }

    socket.data.participantId = participantId;
    socket.data.nickname = nickname;

    const joinBarrier = coordinator.handleJoin(participantId, nickname);
    socket.emit('room:snapshot', room.snapshot());
    socket.emit('chat:history', chatHistory.slice());
    if (!joinBarrier) coordinator.sendBarrier(socket);
    coordinator.broadcastPresence();

    socket.on('sync:request', (ack = () => {}) => {
      if (typeof ack !== 'function') return;
      ack({ ...room.snapshot(), reason: 'sync', serverNow: Date.now() });
    });

    socket.on('presence:buffering', (payload = {}) => {
      coordinator.setBuffering(participantId, socket.id, payload.buffering);
    });

    socket.on('player:ready', (payload = {}) => {
      coordinator.markReady(participantId, socket.id, payload);
    });

    socket.on('media:select', (payload = {}) => {
      const mediaPath = cleanMediaPath(payload.mediaPath);
      if (!mediaPath || !mediaService.isSupportedPath(mediaPath)) return;
      coordinator.cancelBarrier('media-select');
      coordinator.resetBuffering();
      const snapshot = room.apply('select', { mediaPath, mediaName: payload.mediaName }, nickname);
      if (snapshot) io.emit('room:state', snapshot);
    });

    socket.on('player:play', (payload = {}) => {
      coordinator.requestPlay(payload, nickname);
    });

    socket.on('player:pause', (payload = {}) => {
      coordinator.requestPause(payload, nickname);
    });

    socket.on('player:seek', (payload = {}) => {
      coordinator.requestSeek(payload, nickname);
    });

    socket.on('player:rate', (payload = {}) => {
      coordinator.cancelBarrier('rate-change');
      const snapshot = room.apply('rate', payload, nickname);
      if (snapshot) io.emit('room:state', snapshot);
    });

    socket.on('player:desync', (payload = {}) => {
      coordinator.requestResync(payload, nickname);
    });

    socket.on('player:wait', () => {
      coordinator.requestWait(nickname);
    });

    socket.on('chat:send', (payload = {}) => {
      const text = cleanChatMessage(payload.text);
      if (!text) return;
      const message = {
        id: crypto.randomUUID(),
        participantId,
        nickname,
        text,
        sentAt: Date.now(),
      };
      chatHistory.push(message);
      if (chatHistory.length > CHAT_HISTORY_LIMIT) chatHistory.splice(0, chatHistory.length - CHAT_HISTORY_LIMIT);
      io.emit('chat:message', message);
    });

    socket.on('disconnect', () => {
      coordinator.unregisterParticipant(participantId, socket.id);
    });
  });
}

module.exports = { registerSocketGateway, cleanChatMessage, CHAT_HISTORY_LIMIT, CHAT_MESSAGE_LIMIT };
