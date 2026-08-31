/* TogetherVideo sync policy: quality-first, conservative reconciliation.
 *
 * Design notes:
 * - Inspired by mature watch-together clients such as Syncplay: tolerate small
 *   offsets, reserve seeks for major desync, and use playback-rate correction
 *   only for persistent medium drift.
 * - Inspired by Jellyfin SyncPlay clients: rate correction is bounded and
 *   temporary rather than allowed to chase the clock forever.
 * - Browser media pipelines are less deterministic than mpv, so this policy is
 *   intentionally more conservative about changing playbackRate.
 */
(function attachSyncPolicy(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.SyncPolicy = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  const DEFAULTS = Object.freeze({
    rttWindow: 9,
    rttKeepRatio: 0.6,
    maxHalfRttMs: 400,

    // QoE-first thresholds. Small differences are preferable to visible jumps
    // or a viewer obviously running at a different speed.
    settledDrift: 0.25,
    ignoreDrift: 0.75,
    softDrift: 1.5,
    hardDrift: 4.0,
    stableSamples: 3,
    hardStableSamples: 2,
    driftWindow: 5,

    // A medium desync gets only a subtle, fixed correction rate. It is never
    // recomputed every second, which avoids repeated decoder retuning.
    minCorrectionDelta: 0.012,
    maxCorrectionDelta: 0.03,
    correctionGain: 0.012,
    maxCorrectionDurationMs: 30000,
    correctionCooldownMs: 8000,

    // If the error itself is growing extremely quickly, this is not ordinary
    // clock drift. Treat it like a broken rate/stall state instead of chasing it
    // with another playback-rate change.
    runawayMinDrift: 1.0,
    runawayGrowthPerSecond: 0.08,
    runawaySamples: 4,

    afterBufferSoftDelayMs: 4000,
    afterBufferHardDelayMs: 8000,
    hardSeekCooldownMs: 15000,
  });

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function median(values) {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
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
      this.correctionStartedAt = 0;
      this.correctionCooldownUntil = 0;
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
      const value = stable[Math.floor(stable.length / 2)];
      return Math.min(this.options.maxHalfRttMs, Math.max(0, value / 2));
    }

    setBuffering(value, now = Date.now()) {
      const next = Boolean(value);
      if (this.buffering && !next) this.lastBufferEndAt = now;
      this.buffering = next;
      if (next) this.stopCorrection({ cooldown: false });
    }

    resetDrift() {
      this.driftSamples = [];
    }

    stopCorrection({ now = Date.now(), cooldown = false } = {}) {
      this.correctionActive = false;
      this.correctionSign = 0;
      this.correctionRateValue = null;
      this.correctionBaseRate = null;
      this.correctionStartedAt = 0;
      if (cooldown) this.correctionCooldownUntil = Math.max(
        this.correctionCooldownUntil,
        now + this.options.correctionCooldownMs,
      );
    }

    recordDrift(drift, now = Date.now()) {
      const value = Number(drift);
      if (!Number.isFinite(value)) return;
      const previous = this.driftSamples[this.driftSamples.length - 1];
      // A real direction flip means the previous trend is no longer useful.
      if (
        previous
        && Math.abs(value) >= this.options.ignoreDrift
        && Math.abs(previous.value) >= this.options.ignoreDrift
        && Math.sign(previous.value) !== Math.sign(value)
      ) this.resetDrift();
      this.driftSamples.push({ value, at: now });
      while (this.driftSamples.length > this.options.driftWindow) this.driftSamples.shift();
    }

    robustDrift() {
      return median(this.driftSamples.map((sample) => sample.value));
    }

    sameSignCount(threshold) {
      if (!this.driftSamples.length) return 0;
      const sign = Math.sign(this.driftSamples[this.driftSamples.length - 1].value);
      let count = 0;
      for (let i = this.driftSamples.length - 1; i >= 0; i -= 1) {
        const value = this.driftSamples[i].value;
        if (Math.sign(value) !== sign || Math.abs(value) < threshold) break;
        count += 1;
      }
      return count;
    }

    runawayGrowthPerSecond() {
      const count = this.options.runawaySamples;
      if (this.driftSamples.length < count) return 0;
      const samples = this.driftSamples.slice(-count);
      const sign = Math.sign(samples[samples.length - 1].value);
      if (!sign || samples.some((sample) => Math.sign(sample.value) !== sign)) return 0;
      const elapsed = (samples[samples.length - 1].at - samples[0].at) / 1000;
      if (elapsed <= 0) return 0;
      return (Math.abs(samples[samples.length - 1].value) - Math.abs(samples[0].value)) / elapsed;
    }

    correctionRate(drift, desiredRate) {
      const abs = Math.abs(Number(drift || 0));
      const delta = clamp(
        abs * this.options.correctionGain,
        this.options.minCorrectionDelta,
        this.options.maxCorrectionDelta,
      );
      return clamp(drift < 0 ? desiredRate + delta : desiredRate - delta, 0.25, 4);
    }

    startCorrection(drift, desiredRate, now = Date.now()) {
      this.correctionActive = true;
      this.correctionSign = Math.sign(drift);
      this.correctionBaseRate = desiredRate;
      this.correctionRateValue = this.correctionRate(drift, desiredRate);
      this.correctionStartedAt = now;
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
      this.stopCorrection({ now, cooldown: true });
      this.resetDrift();
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

      // Never fight a buffering decoder. Preserve continuity first.
      if (buffering && !force && reason !== 'seek') {
        this.stopCorrection({ now, cooldown: false });
        this.resetDrift();
        return { action: 'hold', rate, absDrift: abs, filteredDrift: value, stableSamples: 0 };
      }

      // Explicit user seek / "立即对轴" is allowed to align precisely. Paused
      // media can also seek because there is no visible playback discontinuity.
      if (force || reason === 'seek' || (!playing && abs > 0.2)) {
        this.stopCorrection({ now, cooldown: false });
        this.resetDrift();
        return {
          action: abs > 0.2 ? 'seek' : 'normal',
          rate,
          reason: force ? 'manual' : reason,
          absDrift: abs,
          filteredDrift: value,
          stableSamples: 0,
        };
      }

      if (reason === 'rate') {
        this.stopCorrection({ now, cooldown: false });
        this.resetDrift();
        return { action: 'normal', rate, absDrift: abs, filteredDrift: value, stableSamples: 0 };
      }

      // Push events update intent immediately but are intentionally excluded from
      // drift decisions. Only the periodic RTT-measured samples can change sync.
      if (!sampled) {
        return {
          action: this.correctionActive ? 'preserve' : 'observe',
          rate,
          absDrift: abs,
          filteredDrift: this.driftSamples.length ? this.robustDrift() : value,
          stableSamples: this.driftSamples.length,
        };
      }

      this.recordDrift(value, now);
      const filtered = this.robustDrift();
      const filteredAbs = Math.abs(filtered);
      const filteredSign = Math.sign(filtered);
      const hardSamples = this.sameSignCount(this.options.hardDrift);
      const softSamples = this.sameSignCount(this.options.softDrift);
      const runawayGrowth = this.runawayGrowthPerSecond();

      // Rapidly increasing error is not normal oscillator drift. It usually means
      // a stuck/incorrect playbackRate or repeated hidden stalls. Do one clean
      // realignment rather than making the other viewer visibly speed up/slow down.
      if (
        filteredAbs >= this.options.runawayMinDrift
        && runawayGrowth >= this.options.runawayGrowthPerSecond
        && this.driftSamples.length >= this.options.runawaySamples
        && sinceHardSeek >= this.options.hardSeekCooldownMs
      ) {
        this.noteHardSeek(now);
        return {
          action: 'seek',
          rate,
          reason: 'runaway',
          absDrift: abs,
          filteredDrift: filtered,
          growthPerSecond: runawayGrowth,
          stableSamples: this.driftSamples.length,
        };
      }

      if (this.correctionActive) {
        if (
          filteredAbs <= this.options.settledDrift
          || (this.correctionSign && filteredSign && filteredSign !== this.correctionSign)
        ) {
          this.stopCorrection({ now, cooldown: true });
          this.resetDrift();
          return { action: 'normal', rate, absDrift: abs, filteredDrift: filtered, stableSamples: 0 };
        }

        if (sinceBuffer < this.options.afterBufferSoftDelayMs) {
          this.stopCorrection({ now, cooldown: true });
          return { action: 'observe', rate, absDrift: abs, filteredDrift: filtered, stableSamples: softSamples };
        }

        if (now - this.correctionStartedAt >= this.options.maxCorrectionDurationMs) {
          this.stopCorrection({ now, cooldown: true });
          return {
            action: 'normal',
            rate,
            reason: 'correction-timeout',
            absDrift: abs,
            filteredDrift: filtered,
            stableSamples: softSamples,
          };
        }

        if (
          filteredAbs >= this.options.hardDrift
          && hardSamples >= this.options.hardStableSamples
          && sinceBuffer >= this.options.afterBufferHardDelayMs
          && sinceHardSeek >= this.options.hardSeekCooldownMs
        ) {
          this.noteHardSeek(now);
          return { action: 'seek', rate, reason: 'major-desync', absDrift: abs, filteredDrift: filtered, stableSamples: hardSamples };
        }

        const heldRate = this.activeCorrectionRate(rate);
        if (heldRate == null) {
          this.stopCorrection({ now, cooldown: true });
          return { action: 'normal', rate, absDrift: abs, filteredDrift: filtered, stableSamples: softSamples };
        }

        return {
          action: 'rate',
          rate: heldRate,
          baseRate: rate,
          absDrift: abs,
          filteredDrift: filtered,
          stableSamples: softSamples,
        };
      }

      // The normal state is deliberately boring. Up to 1.5 s we do not touch
      // playbackRate at all. This follows the same spirit as Syncplay's minor
      // desync tolerance and avoids correcting noise that viewers do not notice.
      if (filteredAbs < this.options.softDrift) {
        if (filteredAbs <= this.options.ignoreDrift) this.resetDrift();
        return {
          action: 'normal',
          rate,
          reason: filteredAbs <= this.options.ignoreDrift ? 'within-comfort-zone' : 'observe-only',
          absDrift: abs,
          filteredDrift: filtered,
          stableSamples: softSamples,
        };
      }

      if (sinceBuffer < this.options.afterBufferSoftDelayMs) {
        return { action: 'observe', rate, absDrift: abs, filteredDrift: filtered, stableSamples: softSamples };
      }

      if (
        filteredAbs >= this.options.hardDrift
        && hardSamples >= this.options.hardStableSamples
        && sinceBuffer >= this.options.afterBufferHardDelayMs
        && sinceHardSeek >= this.options.hardSeekCooldownMs
      ) {
        this.noteHardSeek(now);
        return { action: 'seek', rate, reason: 'major-desync', absDrift: abs, filteredDrift: filtered, stableSamples: hardSamples };
      }

      if (now < this.correctionCooldownUntil) {
        return { action: 'observe', rate, reason: 'correction-cooldown', absDrift: abs, filteredDrift: filtered, stableSamples: softSamples };
      }

      if (softSamples >= this.options.stableSamples) {
        const correctionRate = this.startCorrection(filtered, rate, now);
        return {
          action: 'rate',
          rate: correctionRate,
          baseRate: rate,
          absDrift: abs,
          filteredDrift: filtered,
          stableSamples: softSamples,
        };
      }

      return { action: 'observe', rate, absDrift: abs, filteredDrift: filtered, stableSamples: softSamples };
    }
  }

  return { DEFAULTS, Reconciler };
}));
