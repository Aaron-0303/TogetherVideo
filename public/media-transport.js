(() => {
  const supported = 'serviceWorker' in navigator && window.isSecureContext;
  let mode = supported ? 'registering' : 'direct';
  let readyPromise = null;

  function waitForController(timeoutMs = 5000) {
    if (navigator.serviceWorker.controller) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(Boolean(navigator.serviceWorker.controller)), timeoutMs);
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        clearTimeout(timer);
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
        const registration = await navigator.serviceWorker.register('/sw.js', {
          scope: '/',
          updateViaCache: 'none',
        });
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

  async function sourceUrl(mediaPath, mediaVersion = 0) {
    const controlled = await ensureReady();
    const params = new URLSearchParams({
      path: String(mediaPath || ''),
      v: String(Number(mediaVersion || 0)),
    });
    return controlled
      ? `/__media/stream?${params.toString()}`
      : `/api/media?${params.toString()}`;
  }

  window.MediaTransport = {
    ready: ensureReady,
    sourceUrl,
    supported: () => supported,
    mode: () => mode,
  };

  // Register as early as possible so the first selected movie is already under
  // Service Worker control on Safari/iOS. Failure is harmless: app.js falls back
  // to the existing direct redirect route.
  ensureReady();
})();
