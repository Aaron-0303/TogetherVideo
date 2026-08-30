(() => {
  const video = document.getElementById('video');
  if (!video || !window.io?.Socket?.prototype) return;

  const INTENT_TTL = 1800;
  const EMIT_DEDUPE_MS = 120;
  const guard = {
    socket: null,
    intent: '',
    intentAt: 0,
    lastPlayEmitAt: 0,
    lastPauseEmitAt: 0,
    resyncTimer: null,
  };

  function now() { return Date.now(); }
  function recentIntent(type) { return guard.intent === type && now() - guard.intentAt <= INTENT_TTL; }
  function markIntent(type) {
    guard.intent = type;
    guard.intentAt = now();
  }
  function clearIntent(type) {
    if (guard.intent === type) {
      guard.intent = '';
      guard.intentAt = 0;
    }
  }

  // Native <video> controls do not expose which internal button was clicked.
  // The pre-click paused state is still enough to classify the common play/pause actions.
  function capturePointerIntent() {
    markIntent(video.paused ? 'play' : 'pause');
  }
  video.addEventListener('pointerdown', capturePointerIntent, true);
  video.addEventListener('touchstart', capturePointerIntent, { capture: true, passive: true });
  video.addEventListener('keydown', (event) => {
    if ([' ', 'Spacebar', 'k', 'K', 'MediaPlayPause'].includes(event.key)) capturePointerIntent();
  }, true);

  // Seeking must never be mistaken for an intentional pause while dragging native controls.
  video.addEventListener('seeking', () => {
    if (now() - guard.intentAt <= INTENT_TTL) markIntent('seek');
  }, true);

  // Intercept room-control emits. Programmatic/technical play/pause events are local-only.
  const socketProto = window.io.Socket.prototype;
  const originalEmit = socketProto.emit;
  socketProto.emit = function guardedEmit(event, ...args) {
    if (event === 'room:join') guard.socket = this;

    if (event === 'player:play') {
      if (!recentIntent('play')) {
        console.debug('[sync-guard] ignored non-user player:play');
        return this;
      }
      guard.lastPlayEmitAt = now();
      clearIntent('play');
    }

    if (event === 'player:pause') {
      if (!recentIntent('pause')) {
        console.debug('[sync-guard] ignored technical player:pause');
        return this;
      }
      guard.lastPauseEmitAt = now();
      clearIntent('pause');
    }

    return originalEmit.call(this, event, ...args);
  };

  // The legacy app has skipPlay/skipPause counters. If one of those counters is stale,
  // a real user action can be swallowed. Re-emit the user's intent only when the app did not.
  video.addEventListener('play', () => {
    if (!recentIntent('play')) return;
    const seenAt = now();
    setTimeout(() => {
      if (!guard.socket?.connected || !recentIntent('play')) return;
      if (guard.lastPlayEmitAt >= seenAt - EMIT_DEDUPE_MS) return;
      guard.lastPlayEmitAt = now();
      clearIntent('play');
      originalEmit.call(guard.socket, 'player:play', { position: video.currentTime, userInitiated: true });
    }, 0);
  }, true);

  video.addEventListener('pause', () => {
    if (!recentIntent('pause')) return;
    const seenAt = now();
    setTimeout(() => {
      if (!guard.socket?.connected || !recentIntent('pause') || video.ended) return;
      if (guard.lastPauseEmitAt >= seenAt - EMIT_DEDUPE_MS) return;
      guard.lastPauseEmitAt = now();
      clearIntent('pause');
      originalEmit.call(guard.socket, 'player:pause', { position: video.currentTime, userInitiated: true });
    }, 0);
  }, true);

  // A room play command can arrive while /api/play-info is still resolving. Once the real
  // source becomes ready, ask the server for the authoritative state again instead of
  // letting a stale local pause win the race.
  function resyncWhenReady() {
    clearTimeout(guard.resyncTimer);
    guard.resyncTimer = setTimeout(() => {
      if (guard.socket?.connected) originalEmit.call(guard.socket, 'sync:request');
    }, 80);
  }
  video.addEventListener('loadedmetadata', resyncWhenReady, true);
  video.addEventListener('canplay', resyncWhenReady, true);

  // Source reset/load/error pauses are never room-level user intent.
  video.addEventListener('emptied', () => {
    if (guard.intent !== 'pause') clearIntent('play');
  }, true);
  video.addEventListener('error', () => {
    if (guard.intent !== 'pause') clearIntent('play');
  }, true);
})();
