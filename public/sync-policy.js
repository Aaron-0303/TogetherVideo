/* TogetherVideo sync policy: conservative, hysteresis-based reconciliation. */
(function attachSyncPolicy(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.SyncPolicy = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  const DEFAULTS = Object.freeze({
    rttWindow: 9,
    rttKeepRatio: 0.6,
    maxHalfRttMs: 400,
    settledDrift: 0.6,
    softDrift: 1.2,
    hardDrift: 3.5,
    stableSamples: 3,
    correctionDelta: 0.02,
    afterBufferSoftDelayMs: 5000,
    afterBufferHardDelayMs: 8000,
    hardSeekCooldownMs: 15000,
  });

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  class Reconciler {
    constructor(options = {}) {
      this.options = { ...DEFAULTS, ...options };
      this.rttSamples = [];
      this.driftSamples = [];
      this.correctionActive = false;
      this.lastHardSeekAt = 0;
      this.lastBufferEndAt = 0;
      this.buffering = false;
    }

    sampleRtt(rttMs) {
      const rtt = Number(rttMs);
      if (!Number.isFinite(rtt) || rtt < 0) return this.halfRttMs();
      this.rttSamples.push(rtt);
      while (this.rttSamples.length > this.options.rttWindow) this.rttSamples.shift();
      return this.halfRttMs();
    }

    halfRttMs() {
      if (!this.rttSamples.length) return 0;
      const sorted = [...this.rttSamples].sort((a, b) => a - b);
      const keep = Math.max(1, Math.ceil(sorted.length * this.options.rttKeepRatio));
      const stable = sorted.slice(0, keep);
      const median = stable[Math.floor(stable.length / 2)];
      return Math.min(this.options.maxHalfRttMs, Math.max(0, median / 2));
    }

    setBuffering(value, now = Date.now()) {
      const next = Boolean(value);
      if (this.buffering && !next) this.lastBufferEndAt = now;
      this.buffering = next;
      if (next) {
        this.resetDrift();
        this.correctionActive = false;
      }
    }

    resetDrift() {
      this.driftSamples = [];
    }

    sampleDrift(drift) {
      const value = Number(drift);
      if (!Number.isFinite(value) || Math.abs(value) < this.options.softDrift) {
        this.resetDrift();
        return 0;
      }
      const sign = Math.sign(value);
      const previous = this.driftSamples[this.driftSamples.length - 1];
      if (previous != null && Math.sign(previous) !== sign) this.resetDrift();
      this.driftSamples.push(value);
      while (this.driftSamples.length > this.options.stableSamples + 2) this.driftSamples.shift();
      return this.driftSamples.length;
    }

    noteHardSeek(now = Date.now()) {
      this.lastHardSeekAt = now;
      this.resetDrift();
      this.correctionActive = false;
    }

    decide({
      drift,
      desiredRate = 1,
      playing = false,
      buffering = this.buffering,
      sampled = false,
      force = false,
      reason = '',
      now = Date.now(),
    } = {}) {
      const value = Number(drift || 0);
      const abs = Math.abs(value);
      const rate = clamp(Number(desiredRate || 1), 0.25, 4);
      const sinceBuffer = this.lastBufferEndAt ? now - this.lastBufferEndAt : Number.POSITIVE_INFINITY;
      const sinceHardSeek = this.lastHardSeekAt ? now - this.lastHardSeekAt : Number.POSITIVE_INFINITY;

      // A buffering decoder should never be forced to seek merely because the
      // shared timeline was paused. Let it fill its buffer first; when it reports
      // ready it can align once while the room is still paused.
      if (buffering && !force && reason !== 'seek') {
        this.resetDrift();
        this.correctionActive = false;
        return { action: 'hold', rate, absDrift: abs, stableSamples: 0 };
      }

      if (force || reason === 'seek' || (!playing && abs > 0.2)) {
        this.resetDrift();
        this.correctionActive = false;
        return { action: abs > 0.2 ? 'seek' : 'normal', rate, absDrift: abs, stableSamples: 0 };
      }

      if (reason === 'rate') {
        this.resetDrift();
        this.correctionActive = false;
        return { action: 'normal', rate, absDrift: abs, stableSamples: 0 };
      }

      if (!sampled) {
        return {
          action: this.correctionActive ? 'preserve' : 'observe',
          rate,
          absDrift: abs,
          stableSamples: this.driftSamples.length,
        };
      }

      if (abs <= this.options.settledDrift) {
        this.resetDrift();
        this.correctionActive = false;
        return { action: 'normal', rate, absDrift: abs, stableSamples: 0 };
      }

      if (sinceBuffer < this.options.afterBufferSoftDelayMs) {
        this.resetDrift();
        this.correctionActive = false;
        return { action: 'observe', rate, absDrift: abs, stableSamples: 0 };
      }

      if (abs < this.options.softDrift) {
        this.resetDrift();
        this.correctionActive = false;
        return { action: 'normal', rate, absDrift: abs, stableSamples: 0 };
      }

      const stableSamples = this.sampleDrift(value);
      if (
        abs >= this.options.hardDrift
        && stableSamples >= this.options.stableSamples
        && sinceBuffer >= this.options.afterBufferHardDelayMs
        && sinceHardSeek >= this.options.hardSeekCooldownMs
      ) {
        this.noteHardSeek(now);
        return { action: 'seek', rate, absDrift: abs, stableSamples };
      }

      if (stableSamples >= this.options.stableSamples) {
        const correctedRate = clamp(
          value < 0 ? rate + this.options.correctionDelta : rate - this.options.correctionDelta,
          0.25,
          4,
        );
        this.correctionActive = true;
        return { action: 'rate', rate: correctedRate, baseRate: rate, absDrift: abs, stableSamples };
      }

      return { action: 'observe', rate, absDrift: abs, stableSamples };
    }
  }

  return { DEFAULTS, Reconciler };
}));
