class RoomCoordinator {
  constructor(options = {}) {
    this.io = options.io;
    this.room = options.room;
    this.maxParticipants = Number(options.maxParticipants || 2);
    this.startDelayMs = Number(options.startDelayMs || 900);
    this.bufferingDelayMs = Number(options.bufferingDelayMs || 1500);
    this.participants = new Map();
    this.barrier = null;
    this.barrierSeq = 0;
    this.releaseTimer = null;
    this.bufferingTimer = null;
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

    if (this.barrier && !this.barrier.ready.has(participantId)) {
      this.barrier.ready.set(participantId, false);
    }
    return true;
  }

  handleJoin(participantId, nickname) {
    const current = this.room.snapshot();
    if (
      this.participants.size >= this.maxParticipants
      && current.media
      && current.playing
      && !this.barrier
    ) {
      // Joining an already-running movie is a synchronization event. Pause the
      // room once, let both browsers buffer the same target, then restart them
      // together. This is intentionally disruptive once instead of continuously
      // chasing the late joiner with seeks/rate changes.
      return this.beginBarrier({
        target: current.position,
        mediaVersion: current.mediaVersion,
        reason: 'join',
        actor: nickname || participantId,
      });
    }

    if (this.barrier && !this.barrier.ready.has(participantId)) {
      this.barrier.ready.set(participantId, false);
      this.broadcastBarrier('preparing');
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

    // If a viewer leaves during a barrier, do not strand the remaining viewer.
    // The barrier can release as soon as every still-connected participant is ready.
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

  clearBufferingTimer() {
    clearTimeout(this.bufferingTimer);
    this.bufferingTimer = null;
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

  beginBarrier(options = {}) {
    const current = this.room.snapshot();
    if (!current.media) return null;

    const requested = Number(options.target);
    const target = Number.isFinite(requested) ? Math.max(0, requested) : current.position;
    const mediaVersion = Number(options.mediaVersion ?? current.mediaVersion);
    if (mediaVersion !== current.mediaVersion) return null;

    this.clearReleaseTimer();
    this.clearBufferingTimer();

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

    // Leave enough runway for the release packet to reach both browsers. Clients
    // use serverNow/startAt to convert this to a local timer.
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
    const position = Number(payload.position);
    return this.beginBarrier({
      target: Number.isFinite(position) ? position : current.position,
      mediaVersion: current.mediaVersion,
      reason: 'play',
      actor,
    });
  }

  requestSeek(payload = {}, actor = '') {
    const position = Number(payload.position);
    if (!Number.isFinite(position) || !this.room.matchesMedia(payload)) return null;
    return this.beginBarrier({
      target: position,
      mediaVersion: Number(payload.mediaVersion),
      reason: 'seek',
      actor,
    });
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

  setBuffering(participantId, socketId, buffering) {
    const participant = this.participants.get(participantId);
    if (!participant || !participant.sockets.has(socketId)) return;
    participant.buffering.set(socketId, Boolean(buffering));
    this.broadcastPresence();

    if (!buffering) {
      if (![...this.participants.values()].some((item) => [...item.buffering.values()].some(Boolean))) {
        this.clearBufferingTimer();
      }
      return;
    }

    if (this.barrier || this.bufferingTimer || this.participants.size < this.maxParticipants) return;
    const current = this.room.snapshot();
    if (!current.media || !current.playing) return;

    this.bufferingTimer = setTimeout(() => {
      this.bufferingTimer = null;
      if (this.barrier) return;
      const stillBuffering = [...this.participants.values()]
        .some((item) => [...item.buffering.values()].some(Boolean));
      const latest = this.room.snapshot();
      if (!stillBuffering || !latest.media || !latest.playing) return;
      this.beginBarrier({
        target: latest.position,
        mediaVersion: latest.mediaVersion,
        reason: 'buffering',
        actor: '缓冲保护',
      });
    }, this.bufferingDelayMs);
  }

  resetBuffering() {
    this.clearBufferingTimer();
    for (const participant of this.participants.values()) {
      for (const socketId of participant.buffering.keys()) participant.buffering.set(socketId, false);
    }
    this.cancelBarrier('reset', { broadcast: false });
    this.broadcastPresence();
  }

  stop() {
    this.clearReleaseTimer();
    this.clearBufferingTimer();
    this.barrier = null;
  }
}

module.exports = { RoomCoordinator };
