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
    settledDrift: 0.2,
    softDrift: 0.55,
    hardDrift: 1.25,
    stableSamples: 3,
    hardStableSamples: 2,
    minCorrectionDelta: 0.006,
    maxCorrectionDelta: 0.015,
    correctionGain: 0.012,
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
      while (this.driftSamples.length > Math.max(this.options.stableSamples, this.options.hardStableSamples) + 2) this.driftSamples.shift();
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
      // streams settle. More importantly, the correction is deliberately tiny:
      // a sync controller must never make one viewer look visibly sped-up while
      // the other remains at normal speed.
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

      // 0.20-0.55 s is a dead band. This is already close enough for a private
      // two-viewer room and avoids reacting to RTT/currentTime sampling noise.
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