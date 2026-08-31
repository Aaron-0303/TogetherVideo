class RoomCoordinator {
  constructor(options = {}) {
    this.io = options.io;
    this.room = options.room;
    this.maxParticipants = Number(options.maxParticipants || 2);
    this.pauseDelayMs = Number(options.pauseDelayMs || 2500);
    this.resumeDelayMs = Number(options.resumeDelayMs || 1000);
    this.participants = new Map();
    this.bufferingPauseTimer = null;
    this.bufferingResumeTimer = null;
    this.bufferingHold = null;
  }

  participantList() {
    return [...this.participants.entries()].map(([id, item]) => ({
      id,
      nickname: item.nickname,
      buffering: [...item.buffering.values()].some(Boolean),
    }));
  }

  broadcastPresence() {
    this.io.emit('presence:update', {
      participants: this.participantList(),
      limit: this.maxParticipants,
    });
  }

  registerParticipant(participantId, nickname, socketId) {
    const existing = this.participants.has(participantId);
    if (!existing && this.participants.size >= this.maxParticipants) return false;

    if (!existing) {
      this.participants.set(participantId, { nickname, sockets: new Set(), buffering: new Map() });
    }
    const participant = this.participants.get(participantId);
    participant.nickname = nickname;
    participant.sockets.add(socketId);
    participant.buffering.set(socketId, false);
    return true;
  }

  unregisterParticipant(participantId, socketId) {
    const participant = this.participants.get(participantId);
    if (!participant) return;
    participant.sockets.delete(socketId);
    participant.buffering.delete(socketId);
    if (!participant.sockets.size) this.participants.delete(participantId);
    this.broadcastPresence();
    this.coordinateBuffering();
  }

  setBuffering(participantId, socketId, buffering) {
    const participant = this.participants.get(participantId);
    if (!participant || !participant.sockets.has(socketId)) return;
    participant.buffering.set(socketId, Boolean(buffering));
    this.broadcastPresence();
    this.coordinateBuffering();
  }

  hasBufferingParticipant() {
    if (this.participants.size < this.maxParticipants) return false;
    return [...this.participants.values()].some((item) => [...item.buffering.values()].some(Boolean));
  }

  clearPauseTimer() {
    clearTimeout(this.bufferingPauseTimer);
    this.bufferingPauseTimer = null;
  }

  clearResumeTimer() {
    clearTimeout(this.bufferingResumeTimer);
    this.bufferingResumeTimer = null;
  }

  resetBuffering() {
    this.bufferingHold = null;
    this.clearPauseTimer();
    this.clearResumeTimer();
    for (const participant of this.participants.values()) {
      for (const socketId of participant.buffering.keys()) participant.buffering.set(socketId, false);
    }
    this.broadcastPresence();
  }

  coordinateBuffering() {
    const current = this.room.snapshot();
    if (this.bufferingHold && current.revision !== this.bufferingHold.revision) this.bufferingHold = null;

    if (this.hasBufferingParticipant()) {
      this.clearResumeTimer();
      if (this.bufferingHold || this.bufferingPauseTimer || !current.media || !current.playing) return;

      this.bufferingPauseTimer = setTimeout(() => {
        this.bufferingPauseTimer = null;
        if (!this.hasBufferingParticipant()) return;
        const before = this.room.snapshot();
        if (!before.media || !before.playing) return;

        const paused = this.room.apply('wait', {}, '缓冲保护');
        if (!paused) return;
        this.bufferingHold = { revision: paused.revision, mediaVersion: paused.mediaVersion };
        this.io.emit('room:state', paused);
        this.io.emit('room:buffering-hold', { message: '对方持续缓冲，已暂时一起暂停' });
      }, this.pauseDelayMs);
      return;
    }

    this.clearPauseTimer();
    if (!this.bufferingHold || this.bufferingResumeTimer) return;

    this.bufferingResumeTimer = setTimeout(() => {
      this.bufferingResumeTimer = null;
      if (this.hasBufferingParticipant() || !this.bufferingHold) return;

      const hold = this.bufferingHold;
      const before = this.room.snapshot();
      this.bufferingHold = null;
      if (
        !before.media
        || before.playing
        || before.mediaVersion !== hold.mediaVersion
        || before.revision !== hold.revision
      ) return;

      const resumed = this.room.apply('play', {
        mediaPath: before.media.path,
        mediaVersion: before.mediaVersion,
        position: before.position,
      }, '缓冲恢复');
      if (!resumed) return;
      this.io.emit('room:state', resumed);
      this.io.emit('room:buffering-resume', { message: '双方已就绪，继续播放' });
    }, this.resumeDelayMs);
  }

  stop() {
    this.clearPauseTimer();
    this.clearResumeTimer();
    this.bufferingHold = null;
  }
}

module.exports = { RoomCoordinator };
