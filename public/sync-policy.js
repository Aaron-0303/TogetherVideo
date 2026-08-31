/* TogetherVideo sync policy: tight, symmetric, hysteresis-based reconciliation. */
(function attachSyncPolicy(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.SyncPolicy = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  const DEFAULTS = Object.freeze({
    rttWindow: 9,
    rttKeepRatio: 0.6,
    maxHalfRttMs: 400,
    settledDrift: 0.22,
    softDrift: 0.4,
    hardDrift: 3.0,
    stableSamples: 2,
    hardStableSamples: 3,
    minCorrectionDelta: 0.012,
    maxCorrectionDelta: 0.05,
    correctionGain: 0.035,
    afterBufferSoftDelayMs: 3000,
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
      this.correctionSign = 0;
      this.correctionRateValue = null;
      this.correctionBaseRate = null;
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
      if (next) this.stopCorrection();
    }

    resetDrift() {
      this.driftSamples = [];
    }

    stopCorrection() {
      this.resetDrift();
      this.correctionActive = false;
      this.correctionSign = 0;
      this.correctionRateValue = null;
      this.correctionBaseRate = null;
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
      while (this.driftSamples.length > this.options.hardStableSamples + 2) this.driftSamples.shift();
      return this.driftSamples.length;
    }

    correctionRate(drift, desiredRate) {
      const abs = Math.abs(Number(drift || 0));
      const delta = clamp(
        abs * this.options.correctionGain,
        this.options.minCorrectionDelta,
        this.options.maxCorrectionDelta,
      );
      return clamp(
        drift < 0 ? desiredRate + delta : desiredRate - delta,
        0.25,
        4,
      );
    }

    startCorrection(drift, desiredRate) {
      this.correctionActive = true;
      this.correctionSign = Math.sign(drift);
      this.correctionBaseRate = desiredRate;
      this.correctionRateValue = this.correctionRate(drift, desiredRate);
      return this.correctionRateValue;
    }

    activeCorrectionRate(desiredRate) {
      if (
        !Number.isFinite(this.correctionRateValue)
        || !Number.isFinite(this.correctionBaseRate)
        || Math.abs(this.correctionBaseRate - desiredRate) > 0.001
      ) return null;
      return this.correctionRateValue;
    }

    noteHardSeek(now = Date.now()) {
      this.lastHardSeekAt = now;
      this.stopCorrection();
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
      const sign = Math.sign(value);
      const rate = clamp(Number(desiredRate || 1), 0.25, 4);
      const sinceBuffer = this.lastBufferEndAt ? now - this.lastBufferEndAt : Number.POSITIVE_INFINITY;
      const sinceHardSeek = this.lastHardSeekAt ? now - this.lastHardSeekAt : Number.POSITIVE_INFINITY;

      // A buffering decoder should never be forced to seek merely because the
      // shared timeline was paused. Let it fill first and align after recovery.
      if (buffering && !force && reason !== 'seek') {
        this.stopCorrection();
        return { action: 'hold', rate, absDrift: abs, stableSamples: 0 };
      }

      if (force || reason === 'seek' || (!playing && abs > 0.2)) {
        this.stopCorrection();
        return { action: abs > 0.2 ? 'seek' : 'normal', rate, absDrift: abs, stableSamples: 0 };
      }

      if (reason === 'rate') {
        this.stopCorrection();
        return { action: 'normal', rate, absDrift: abs, stableSamples: 0 };
      }

      // Push events are applied immediately but do not count as drift samples.
      if (!sampled) {
        return {
          action: this.correctionActive ? 'preserve' : 'observe',
          rate,
          absDrift: abs,
          stableSamples: this.driftSamples.length,
        };
      }

      // Once a soft correction starts, keep one steady playback rate until the
      // streams settle. Recalculating playbackRate every one-second sync sample
      // makes Safari/Chromium repeatedly retune their media pipeline and can feel
      // like tiny periodic stalls even though the timeline itself is continuous.
      if (this.correctionActive) {
        if (abs <= this.options.settledDrift || (this.correctionSign && sign !== this.correctionSign)) {
          this.stopCorrection();
          return { action: 'normal', rate, absDrift: abs, stableSamples: 0 };
        }
        if (sinceBuffer < this.options.afterBufferSoftDelayMs) {
          this.stopCorrection();
          return { action: 'observe', rate, absDrift: abs, stableSamples: 0 };
        }

        const heldRate = this.activeCorrectionRate(rate);
        if (heldRate == null) {
          this.stopCorrection();
          return { action: 'normal', rate, absDrift: abs, stableSamples: 0 };
        }

        let stableSamples = this.driftSamples.length;
        if (abs >= this.options.hardDrift) {
          stableSamples = this.sampleDrift(value);
          if (
            stableSamples >= this.options.hardStableSamples
            && sinceBuffer >= this.options.afterBufferHardDelayMs
            && sinceHardSeek >= this.options.hardSeekCooldownMs
          ) {
            this.noteHardSeek(now);
            return { action: 'seek', rate, absDrift: abs, stableSamples };
          }
        }

        return {
          action: 'rate',
          rate: heldRate,
          baseRate: rate,
          absDrift: abs,
          stableSamples,
        };
      }

      if (abs <= this.options.settledDrift) {
        this.stopCorrection();
        return { action: 'normal', rate, absDrift: abs, stableSamples: 0 };
      }

      if (sinceBuffer < this.options.afterBufferSoftDelayMs) {
        this.stopCorrection();
        return { action: 'observe', rate, absDrift: abs, stableSamples: 0 };
      }

      // 0.22-0.40 s is intentionally a dead band: visible sync is already good
      // and no playback-rate changes are worth introducing here.
      if (abs < this.options.softDrift) {
        this.resetDrift();
        return { action: 'normal', rate, absDrift: abs, stableSamples: 0 };
      }

      const stableSamples = this.sampleDrift(value);
      if (
        abs >= this.options.hardDrift
        && stableSamples >= this.options.hardStableSamples
        && sinceBuffer >= this.options.afterBufferHardDelayMs
        && sinceHardSeek >= this.options.hardSeekCooldownMs
      ) {
        this.noteHardSeek(now);
        return { action: 'seek', rate, absDrift: abs, stableSamples };
      }

      if (stableSamples >= this.options.stableSamples) {
        const correctionRate = this.startCorrection(value, rate);
        return {
          action: 'rate',
          rate: correctionRate,
          baseRate: rate,
          absDrift: abs,
          stableSamples,
        };
      }

      return { action: 'observe', rate, absDrift: abs, stableSamples };
    }
  }

  return { DEFAULTS, Reconciler };
}));
