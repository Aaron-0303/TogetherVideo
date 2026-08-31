/* TogetherVideo 3.2 retirement worker.
 *
 * 3.2 no longer proxies media through a Service Worker. Artplayer uses the
 * browser's native HTMLVideoElement and receives a final provider CDN URL from
 * /api/media/url. This tiny worker exists only so browsers with a previously
 * installed 3.1.x media worker can update to a non-intercepting worker and then
 * unregister it cleanly.
 */
self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    try { await self.clients.claim(); } catch {}
    try { await self.registration.unregister(); } catch {}
  })());
});

// Intentionally no fetch handler.
