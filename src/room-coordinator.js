class RoomCoordinator {
  constructor(options = {}) {
    this.io = options.io;
    this.room = options.room;
    this.maxParticipants = Number(options.maxParticipants || 2);
    // Short shared runway: enough for the same control packet to reach both
    // browsers, but never long enough to behave like a cache barrier.
    this.startDelayMs = Number(options.startDelayMs || 500);
    this.participants = new Map();
  }

  participantList() {
    return [...this.participants.entries()].map(([id, item]) => ({
      id,
      nickname: item.nickname,
      buffering: [...item.buffering.values()].some(Boolean),
      ready: false,
    }));
  }

  broadcastPresence() {
    this.io.emit('presence:update', {
      participants: this.participantList(),
      limit: this.maxParticipants,
      barrierId: 0,
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
    return true;
  }

  // Joining is presence-only. A late viewer must never pause the viewer who is
  // already watching. Both media pipelines stay independent.
  handleJoin() {
    return null;
  }

  unregisterParticipant(participantId, socketId) {
    const participant = this.participants.get(participantId);
    if (!participant) return;
    participant.sockets.delete(socketId);
    participant.buffering.delete(socketId);
    if (!participant.sockets.size) this.participants.delete(participantId);
    this.broadcastPresence();
  }

  // Kept as no-ops for the existing socket/client contract. 3.2.5 no longer
  // uses readiness barriers for normal playback or manual re-alignment.
  sendBarrier() {}
  cancelBarrier() {}
  markReady() { return false; }
  maybeReleaseBarrier() {}

  emitState(snapshot) {
    if (snapshot) this.io.emit('room:state', snapshot);
    return snapshot;
  }

  schedulePlayAt(position, actor = '', reason = 'play', delayMs = this.startDelayMs) {
    const current = this.room.snapshot();
    if (!current.media) return null;
    const target = Math.max(0, Number.isFinite(Number(position)) ? Number(position) : current.position);
    const startAt = Date.now() + Math.max(0, Number(delayMs || 0));
    return this.emitState(this.room.apply('play', {
      mediaPath: current.media.path,
      mediaVersion: current.mediaVersion,
      position: target,
      startAt,
      reason,
    }, actor));
  }

  requestPlay(payload = {}, actor = '') {
    const current = this.room.snapshot();
    if (!current.media || !this.room.matchesMedia(payload)) return null;
    const position = Number(payload.position);
    return this.schedulePlayAt(
      Number.isFinite(position) ? position : current.position,
      actor,
      'play',
      this.startDelayMs,
    );
  }

  requestPause(payload = {}, actor = '') {
    if (!this.room.matchesMedia(payload)) return null;
    return this.emitState(this.room.apply('pause', {
      ...payload,
      reason: 'pause',
    }, actor));
  }

  requestSeek(payload = {}, actor = '') {
    const position = Number(payload.position);
    if (!Number.isFinite(position) || !this.room.matchesMedia(payload)) return null;

    const before = this.room.snapshot();
    const wasPlaying = Boolean(before.playing);

    // A synchronized seek should feel exactly like both users manually dragging
    // their own progress bars: issue one common target, let each browser fetch its
    // own Range independently, and do not compare or wait for buffer amounts.
    const pausedAtTarget = this.emitState(this.room.apply('pause', {
      ...payload,
      position,
      reason: 'pause',
    }, actor));

    if (!pausedAtTarget || !wasPlaying) return pausedAtTarget;

    // Give both browsers a very small common runway to issue their local Range
    // request, then start by server time. A slow browser may buffer locally, but
    // it can never hold the other browser hostage.
    return this.schedulePlayAt(position, actor, 'seek-resume', this.startDelayMs);
  }

  requestWait(actor = '') {
    const paused = this.room.apply('wait', { reason: 'wait' }, actor);
    if (paused) {
      this.io.emit('room:state', paused);
      this.io.emit('room:wait', { nickname: actor });
    }
    return paused;
  }

  requestResync(payload = {}, actor = '') {
    // Automatic drift measurements are advisory only. They must never interrupt
    // normal playback. Only the explicit "重新同步" button sends manual=true.
    if (payload.manual !== true) return null;

    const current = this.room.snapshot();
    if (!current.media || !this.room.matchesMedia(payload)) return null;
    const target = current.position;
    const wasPlaying = Boolean(current.playing);

    const paused = this.emitState(this.room.apply('pause', {
      mediaPath: current.media.path,
      mediaVersion: current.mediaVersion,
      position: target,
      reason: 'pause',
    }, actor));
    if (!paused || !wasPlaying) return paused;

    return this.schedulePlayAt(target, actor, 'resync', this.startDelayMs + 250);
  }

  // Buffering is strictly per-viewer telemetry. There is intentionally no path
  // from buffering -> pause/seek/barrier. Each browser owns its CDN/Range/cache.
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

  stop() {}
}

module.exports = { RoomCoordinator };
