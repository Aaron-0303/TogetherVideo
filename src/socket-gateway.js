const crypto = require('crypto');
const { cleanMediaPath } = require('./watch-room');
const { cleanName } = require('./identity');

function registerSocketGateway(options = {}) {
  const { io, room, coordinator, mediaService } = options;

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

    socket.emit('room:snapshot', room.snapshot());
    coordinator.broadcastPresence();
    coordinator.coordinateBuffering();

    socket.on('sync:request', (ack = () => {}) => {
      if (typeof ack !== 'function') return;
      ack({ ...room.snapshot(), reason: 'sync' });
    });

    socket.on('presence:buffering', (payload = {}) => {
      coordinator.setBuffering(participantId, socket.id, payload.buffering);
    });

    const apply = (action, payload = {}, applyOptions = {}) => {
      const snapshot = room.apply(action, payload, nickname);
      if (!snapshot) return;

      if (applyOptions.noSelfEcho) {
        socket.emit('room:state', { ...snapshot, reason: `${snapshot.reason}-ack` });
        socket.broadcast.emit('room:state', snapshot);
      } else {
        io.emit('room:state', snapshot);
      }
      coordinator.coordinateBuffering();
    };

    socket.on('media:select', (payload = {}) => {
      const mediaPath = cleanMediaPath(payload.mediaPath);
      if (!mediaPath || !mediaService.isSupportedPath(mediaPath)) return;
      apply('select', { mediaPath, mediaName: payload.mediaName });
    });
    socket.on('player:play', (payload = {}) => apply('play', payload));
    socket.on('player:pause', (payload = {}) => apply('pause', payload));
    socket.on('player:seek', (payload = {}) => apply('seek', payload, { noSelfEcho: true }));
    socket.on('player:rate', (payload = {}) => apply('rate', payload));
    socket.on('player:wait', () => {
      const snapshot = room.apply('wait', {}, nickname);
      if (!snapshot) return;
      io.emit('room:state', snapshot);
      io.emit('room:wait', { nickname });
      coordinator.coordinateBuffering();
    });

    socket.on('disconnect', () => {
      coordinator.unregisterParticipant(participantId, socket.id);
    });
  });
}

module.exports = { registerSocketGateway };
