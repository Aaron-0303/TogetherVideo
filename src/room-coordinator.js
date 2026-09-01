class RoomCoordinator {
  constructor(options = {}) {
    this.io = options.io;
    this.room = options.room;
    this.maxParticipants = Number(options.maxParticipants || 2);
    this.startDelayMs = Number(options.startDelayMs || 900);
    this.participants = new Map();
    this.barrier = null;
    this.barrierSeq = 0;
    this.releaseTimer = null;
  }

  participantList() {
    return [...this.participants.entries()].map(([id, item]) => ({
      id,
      nickname: item.nickname,
      buffering: [...item.buffering.values()].some(Boolean),
      ready: Boolean(this.barrier?.ready.get(id)),
    }));
  }

  broadcastPresence() {
    this.io.emit('presence:update', {
      participants: this.participantList(),
      limit: this.maxParticipants,
      barrierId: this.barrier?.id || 0,
    });
  }

  registerParticipant(participantId, nickname, socketId) {
    const existing = this.participants.has(participantId);
    if (!existing && this.participants.size >= this.maxParticipants) return false;

    if (!existing) {
      this.participants.set(participantId, {
        nickname,
        sockets: new Set(),
        buffering: new Map(),
      });
    }
    const participant = this.participants.get(participantId);
    participant.nickname = nickname;
    participant.sockets.add(socketId);
    participant.buffering.set(socketId, false);

    // A participant only joins readiness bookkeeping when an explicit resync is
    // already in progress. Normal joining never pauses the other viewer.
    if (this.barrier && !this.barrier.ready.has(participantId)) {
      this.barrier.ready.set(participantId, false);
    }
    return true;
  }

  handleJoin(participantId) {
    if (this.barrier && !this.barrier.ready.has(participantId)) {
      this.barrier.ready.set(participantId, false);
      this.broadcastBarrier('preparing');
      return this.barrierPayload('preparing');
    }
    return null;
  }

  unregisterParticipant(participantId, socketId) {
    const participant = this.participants.get(participantId);
    if (!participant) return;
    participant.sockets.delete(socketId);
    participant.buffering.delete(socketId);
    if (!participant.sockets.size) {
      this.participants.delete(participantId);
      this.barrier?.ready.delete(participantId);
    }
    this.broadcastPresence();
    this.maybeReleaseBarrier();
  }

  barrierPayload(phase = 'preparing', extra = {}) {
    if (!this.barrier) return null;
    return {
      phase,
      id: this.barrier.id,
      target: this.barrier.target,
      mediaVersion: this.barrier.mediaVersion,
      reason: this.barrier.reason,
      createdAt: this.barrier.createdAt,
      participants: this.participantList().map((item) => ({
        id: item.id,
        nickname: item.nickname,
        ready: item.ready,
      })),
      serverNow: Date.now(),
      ...extra,
    };
  }

  broadcastBarrier(phase = 'preparing', extra = {}) {
    const payload = this.barrierPayload(phase, extra);
    if (payload) this.io.emit('room:barrier', payload);
    this.broadcastPresence();
  }

  sendBarrier(socket) {
    if (!this.barrier) return;
    socket.emit('room:barrier', this.barrierPayload('preparing'));
  }

  clearReleaseTimer() {
    clearTimeout(this.releaseTimer);
    this.releaseTimer = null;
  }

  cancelBarrier(reason = 'cancelled', { broadcast = true } = {}) {
    if (!this.barrier) return;
    const previous = this.barrier;
    this.clearReleaseTimer();
    this.barrier = null;
    if (broadcast) {
      this.io.emit('room:barrier', {
        phase: 'cancelled',
        id: previous.id,
        reason,
        serverNow: Date.now(),
      });
    }
    this.broadcastPresence();
  }

  // Barrier is intentionally reserved for an explicit re-alignment request.
  // It must never be opened by ordinary buffering, play, seek, or late join.
  beginBarrier(options = {}) {
    const current = this.room.snapshot();
    if (!current.media) return null;

    const requested = Number(options.target);
    const target = Number.isFinite(requested) ? Math.max(0, requested) : current.position;
    const mediaVersion = Number(options.mediaVersion ?? current.mediaVersion);
    if (mediaVersion !== current.mediaVersion) return null;

    this.clearReleaseTimer();

    const prepared = this.room.apply('prepare', {
      mediaPath: current.media.path,
      mediaVersion: current.mediaVersion,
      position: target,
      reason: `barrier-${String(options.reason || 'sync')}`,
    }, options.actor || '同步');
    if (!prepared) return null;

    this.barrier = {
      id: ++this.barrierSeq,
      target,
      mediaVersion: current.mediaVersion,
      reason: String(options.reason || 'sync'),
      actor: String(options.actor || ''),
      createdAt: Date.now(),
      ready: new Map([...this.participants.keys()].map((id) => [id, false])),
    };

    this.io.emit('room:state', prepared);
    this.broadcastBarrier('preparing');
    return this.barrierPayload('preparing');
  }

  markReady(participantId, socketId, payload = {}) {
    const participant = this.participants.get(participantId);
    const barrier = this.barrier;
    if (!participant || !participant.sockets.has(socketId) || !barrier) return false;
    if (Number(payload.barrierId) !== barrier.id) return false;
    if (Number(payload.mediaVersion) !== barrier.mediaVersion) return false;

    participant.buffering.set(socketId, false);
    barrier.ready.set(participantId, true);
    this.broadcastBarrier('preparing');
    this.maybeReleaseBarrier();
    return true;
  }

  maybeReleaseBarrier() {
    const barrier = this.barrier;
    if (!barrier || this.releaseTimer || this.participants.size === 0) return;

    const everyoneReady = [...this.participants.keys()].every((id) => barrier.ready.get(id) === true);
    if (!everyoneReady) return;

    const current = this.room.snapshot();
    if (!current.media || current.mediaVersion !== barrier.mediaVersion) {
      this.cancelBarrier('media-changed');
      return;
    }

    const startAt = Date.now() + this.startDelayMs;
    const released = this.room.apply('play', {
      mediaPath: current.media.path,
      mediaVersion: current.mediaVersion,
      position: barrier.target,
      startAt,
      reason: 'barrier-release',
    }, '同步开始');
    if (!released) return;

    this.io.emit('room:state', released);
    this.broadcastBarrier('starting', { startAt, rate: released.rate });

    const releasedId = barrier.id;
    this.releaseTimer = setTimeout(() => {
      this.releaseTimer = null;
      if (!this.barrier || this.barrier.id !== releasedId) return;
      this.io.emit('room:barrier', {
        phase: 'running',
        id: releasedId,
        startAt,
        serverNow: Date.now(),
      });
      this.barrier = null;
      this.broadcastPresence();
    }, this.startDelayMs + 700);
  }

  requestPlay(payload = {}, actor = '') {
    const current = this.room.snapshot();
    if (!current.media || !this.room.matchesMedia(payload)) return null;
    this.cancelBarrier('play');
    const position = Number(payload.position);
    const started = this.room.apply('play', {
      mediaPath: current.media.path,
      mediaVersion: current.mediaVersion,
      position: Number.isFinite(position) ? position : current.position,
      reason: 'play',
    }, actor);
    if (started) this.io.emit('room:state', started);
    return started;
  }

  requestSeek(payload = {}, actor = '') {
    const position = Number(payload.position);
    if (!Number.isFinite(position) || !this.room.matchesMedia(payload)) return null;
    this.cancelBarrier('seek');
    const moved = this.room.apply('seek', {
      ...payload,
      position,
      reason: 'seek',
    }, actor);
    if (moved) this.io.emit('room:state', moved);
    return moved;
  }

  requestPause(payload = {}, actor = '') {
    if (!this.room.matchesMedia(payload)) return null;
    this.cancelBarrier('manual-pause');
    const paused = this.room.apply('pause', {
      ...payload,
      reason: 'pause',
    }, actor);
    if (paused) this.io.emit('room:state', paused);
    return paused;
  }

  requestWait(actor = '') {
    this.cancelBarrier('wait');
    const paused = this.room.apply('wait', { reason: 'wait' }, actor);
    if (paused) {
      this.io.emit('room:state', paused);
      this.io.emit('room:wait', { nickname: actor });
    }
    return paused;
  }

  requestResync(payload = {}, actor = '') {
    const current = this.room.snapshot();
    if (!current.media || !current.playing || !this.room.matchesMedia(payload)) return null;
    return this.beginBarrier({
      target: current.position,
      mediaVersion: current.mediaVersion,
      reason: 'desync',
      actor,
    });
  }

  // Buffering belongs to each browser's private media lane. Report it for UI only;
  // never pause, seek, or create a room barrier because one viewer is buffering.
  setBuffering(participantId, socketId, buffering) {
    const participant = this.participants.get(participantId);
    if (!participant || !participant.sockets.has(socketId)) return;
    participant.buffering.set(socketId, Boolean(buffering));
    this.broadcastPresence();
  }

  resetBuffering() {
    for (const participant of this.participants.values()) {
      for (const socketId of participant.buffering.keys()) participant.buffering.set(socketId, false);
    }
    this.broadcastPresence();
  }

  stop() {
    this.clearReleaseTimer();
    this.barrier = null;
  }
}

module.exports = { RoomCoordinator };
