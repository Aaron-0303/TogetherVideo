(() => {
  const supported = 'serviceWorker' in navigator && window.isSecureContext;
  let mode = supported ? 'registering' : 'direct';
  let readyPromise = null;

  function retryFailedMediaSoon() {
    for (const delay of [0, 500, 1500]) {
      setTimeout(() => {
        const player = window.TogetherMediaPlayer;
        const video = player?.video || document.getElementById('video');
        const raw = player?.src || video?.getAttribute('src') || '';
        if (!video || !raw || !video.error) return;
        try {
          const url = new URL(raw, location.href);
          if (url.pathname !== '/api/media') return;
        } catch { return; }

        // A failed request may have escaped before a newly-installed worker took
        // control. Retry only the failed media element; never disturb live playback.
        try { player?.removeAttribute?.('src'); } catch { video.removeAttribute('src'); }
        try { player?.load?.(); } catch { try { video.load(); } catch {} }
        if (player) {
          player.src = raw;
          player.load();
        } else {
          video.src = raw;
          video.load();
        }
      }, delay);
    }
  }

  function waitForController(timeoutMs = 6000) {
    if (navigator.serviceWorker.controller) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(Boolean(navigator.serviceWorker.controller)), timeoutMs);
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        clearTimeout(timer);
        mode = 'service-worker';
        retryFailedMediaSoon();
        resolve(true);
      }, { once: true });
    });
  }

  function ensureReady() {
    if (readyPromise) return readyPromise;
    if (!supported) {
      readyPromise = Promise.resolve(false);
      return readyPromise;
    }

    readyPromise = (async () => {
      try {
        const registration = await navigator.serviceWorker.register('/sw.js?v=3.2.5', { scope: '/' });
        registration.update().catch(() => {});
        await navigator.serviceWorker.ready;
        const controlled = await waitForController();
        mode = controlled ? 'service-worker' : 'direct';
        return controlled;
      } catch (error) {
        console.warn('[TogetherVideo] Service Worker unavailable:', error);
        mode = 'direct';
        return false;
      }
    })();

    return readyPromise;
  }

  window.MediaTransport = {
    ready: ensureReady,
    supported: () => supported,
    mode: () => mode,
  };

  // Start registration before the room app constructs ArtPlayer. media-stability
  // will still await this promise before assigning the first real media source.
  ensureReady();
})();
