'use strict';

(function attachMediaRecovery(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MediaRecovery = api;
}(typeof globalThis === 'object' ? globalThis : this, function createMediaRecovery() {
  const RETRY_DELAYS_MS = Object.freeze([500, 1500, 3500, 7000, 12000]);
  const SHARE_BUFFERING_AFTER_MS = 700;
  const STALL_RELOAD_AFTER_MS = 12000;
  const STABLE_PLAY_MS = 3000;
  const STABLE_PROGRESS_SECONDS = 2.25;

  function finite(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function createTracker() {
    let phase = 'idle';
    let rendered = false;
    let stallStartedAt = 0;
    let stallPosition = 0;
    let attempts = 0;
    let reloadScheduled = false;
    let stableStartedAt = 0;
    let stableStartedPosition = 0;
    let lastProgressPosition = 0;

    function snapshot(extra = {}) {
      return {
        phase,
        rendered,
        stallStartedAt,
        attempts,
        reloadScheduled,
        freezeSync: ['stalled', 'recovering', 'stabilizing'].includes(phase),
        ...extra,
      };
    }

    function reset(options = {}) {
      phase = options.preparing ? 'preparing' : 'idle';
      rendered = Boolean(options.rendered);
      stallStartedAt = 0;
      stallPosition = finite(options.position);
      attempts = options.keepAttempts ? attempts : 0;
      reloadScheduled = false;
      stableStartedAt = 0;
      stableStartedPosition = stallPosition;
      lastProgressPosition = stallPosition;
      return snapshot();
    }

    function markRendered(position = 0) {
      rendered = true;
      lastProgressPosition = finite(position, lastProgressPosition);
      if (phase === 'preparing' || phase === 'idle') phase = 'steady';
      return snapshot({ firstFrame: true });
    }

    function beginStall({ position = 0, now = Date.now() } = {}) {
      if (!rendered) return snapshot({ ignored: true, reason: 'before-first-frame' });
      if (!['stalled', 'recovering', 'stabilizing'].includes(phase)) {
        phase = 'stalled';
        stallStartedAt = now;
        stallPosition = finite(position);
        stableStartedAt = 0;
        stableStartedPosition = stallPosition;
        lastProgressPosition = stallPosition;
        reloadScheduled = false;
      } else if (phase === 'stabilizing') {
        phase = 'stalled';
        stallStartedAt = now;
        stallPosition = finite(position);
        stableStartedAt = 0;
        stableStartedPosition = stallPosition;
      }
      return snapshot({ ignored: false });
    }

    function stallStatus(now = Date.now()) {
      if (!['stalled', 'recovering'].includes(phase) || !stallStartedAt) {
        return snapshot({ shouldShareBuffering: false, shouldReload: false, stalledForMs: 0 });
      }
      const stalledForMs = Math.max(0, now - stallStartedAt);
      return snapshot({
        stalledForMs,
        shouldShareBuffering: stalledForMs >= SHARE_BUFFERING_AFTER_MS,
        shouldReload: stalledForMs >= STALL_RELOAD_AFTER_MS && !reloadScheduled,
      });
    }

    function markPlayable() {
      if (phase === 'stalled' || phase === 'recovering') {
        phase = 'recovering';
        stableStartedAt = 0;
      }
      return snapshot({ clearSharedBuffering: rendered });
    }

    function noteProgress({ position = 0, readyState = 0, paused = false, seeking = false, now = Date.now() } = {}) {
      const current = finite(position, lastProgressPosition);
      const forward = current > lastProgressPosition + 0.015;
      lastProgressPosition = current;

      if (!rendered || paused || seeking || Number(readyState) < 3 || !forward) {
        if (phase === 'stabilizing' && (paused || seeking || Number(readyState) < 3)) {
          phase = 'recovering';
          stableStartedAt = 0;
        }
        return snapshot({ recovered: false, forward });
      }

      if (phase === 'stalled' || phase === 'recovering') {
        phase = 'stabilizing';
        stableStartedAt = now;
        stableStartedPosition = current;
        return snapshot({ recovered: false, forward: true });
      }

      if (phase === 'stabilizing') {
        const elapsedMs = Math.max(0, now - stableStartedAt);
        const progressedSeconds = Math.max(0, current - stableStartedPosition);
        if (elapsedMs >= STABLE_PLAY_MS && progressedSeconds >= STABLE_PROGRESS_SECONDS) {
          phase = 'steady';
          stallStartedAt = 0;
          attempts = 0;
          reloadScheduled = false;
          stableStartedAt = 0;
          return snapshot({ recovered: true, forward: true, elapsedMs, progressedSeconds });
        }
        return snapshot({ recovered: false, forward: true, elapsedMs, progressedSeconds });
      }

      return snapshot({ recovered: false, forward: true });
    }

    function invalidateStability() {
      if (phase === 'stabilizing') {
        phase = 'recovering';
        stableStartedAt = 0;
      }
      return snapshot();
    }

    function cancelStall({ keepAttempts = true } = {}) {
      phase = rendered ? 'steady' : 'preparing';
      stallStartedAt = 0;
      reloadScheduled = false;
      stableStartedAt = 0;
      if (!keepAttempts) attempts = 0;
      return snapshot();
    }

    function nextRetry() {
      if (attempts >= RETRY_DELAYS_MS.length) return null;
      const delayMs = RETRY_DELAYS_MS[attempts];
      attempts += 1;
      reloadScheduled = true;
      phase = 'recovering';
      return { attempt: attempts, delayMs, maxAttempts: RETRY_DELAYS_MS.length };
    }

    function markReloadStarted(now = Date.now(), position = stallPosition) {
      phase = 'recovering';
      rendered = false;
      stallStartedAt = now;
      stallPosition = finite(position, stallPosition);
      reloadScheduled = false;
      stableStartedAt = 0;
      stableStartedPosition = stallPosition;
      lastProgressPosition = stallPosition;
      return snapshot();
    }

    function markReloadMetadata() {
      phase = 'recovering';
      return snapshot();
    }

    function shouldFreezeSync() {
      return ['stalled', 'recovering', 'stabilizing'].includes(phase);
    }

    return Object.freeze({
      reset,
      markRendered,
      beginStall,
      stallStatus,
      markPlayable,
      noteProgress,
      invalidateStability,
      cancelStall,
      nextRetry,
      markReloadStarted,
      markReloadMetadata,
      shouldFreezeSync,
      snapshot,
    });
  }

  return Object.freeze({
    RETRY_DELAYS_MS,
    SHARE_BUFFERING_AFTER_MS,
    STALL_RELOAD_AFTER_MS,
    STABLE_PLAY_MS,
    STABLE_PROGRESS_SECONDS,
    createTracker,
  });
}));
