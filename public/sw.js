/* TogetherVideo browser-local media bridge.
 * Video bytes flow directly from the provider CDN to this browser.
 * The TogetherVideo server only resolves short-lived provider URLs; it never
 * receives, proxies, buffers, or caches media bytes.
 */
const SOURCE_TTL_MS = 120000;
const sourceCache = new Map();

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

function mimeForPath(mediaPath, fallback = '') {
  const clean = String(mediaPath || '').split('?')[0].toLowerCase();
  if (clean.endsWith('.mp4')) return 'video/mp4';
  if (clean.endsWith('.m4v')) return 'video/x-m4v';
  if (clean.endsWith('.mov')) return 'video/quicktime';
  if (clean.endsWith('.webm')) return 'video/webm';
  if (clean.endsWith('.ogv') || clean.endsWith('.ogg')) return 'video/ogg';
  if (clean.endsWith('.mkv')) return 'video/x-matroska';
  return fallback || 'application/octet-stream';
}

async function resolveSource(mediaPath, fresh = false) {
  const now = Date.now();
  const cached = sourceCache.get(mediaPath);
  if (!fresh && cached && cached.expiresAt > now) return cached;

  const endpoint = new URL('/api/media/source', self.location.origin);
  endpoint.searchParams.set('path', mediaPath);
  if (fresh) endpoint.searchParams.set('fresh', '1');

  const response = await fetch(endpoint, {
    method: 'GET',
    credentials: 'include',
    cache: 'no-store',
    headers: { Accept: 'application/json' },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false || !data.source?.url) {
    throw new Error(data.error || `media source HTTP ${response.status}`);
  }

  const source = {
    url: String(data.source.url),
    mime: mimeForPath(mediaPath, data.source.mime || ''),
    expiresAt: now + SOURCE_TTL_MS,
  };
  sourceCache.set(mediaPath, source);
  return source;
}

async function providerFetch(request, source) {
  const headers = new Headers();
  // Preserve the browser's exact single-range request. If the browser starts
  // without one, request bytes=0- so the provider still returns a range-aware
  // 206 response suitable for Safari media loading.
  headers.set('Range', request.headers.get('range') || 'bytes=0-');

  return fetch(source.url, {
    method: 'GET',
    headers,
    mode: 'cors',
    credentials: 'omit',
    redirect: 'follow',
    cache: 'no-store',
  });
}

function browserMediaResponse(upstream, mime) {
  const headers = new Headers();
  const copy = ['content-range', 'content-length', 'accept-ranges', 'etag', 'last-modified'];
  for (const name of copy) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }

  headers.set('Content-Type', mime || 'video/mp4');
  headers.set('Content-Disposition', 'inline');
  headers.set('Accept-Ranges', 'bytes');
  headers.set('Cache-Control', 'private, no-store');
  headers.set('X-TogetherVideo-Media-Mode', 'browser-service-worker');

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

async function handleMedia(request, requestUrl) {
  const mediaPath = requestUrl.searchParams.get('path') || '';
  if (!mediaPath) return new Response('Missing media path', { status: 400 });

  try {
    let source = await resolveSource(mediaPath, false);
    let upstream = await providerFetch(request, source);

    // Signed provider URLs can expire during a long movie. Resolve a fresh URL
    // once and retry the exact browser Range instead of failing playback.
    if (upstream.status === 401 || upstream.status === 403) {
      await upstream.body?.cancel().catch(() => {});
      sourceCache.delete(mediaPath);
      source = await resolveSource(mediaPath, true);
      upstream = await providerFetch(request, source);
    }

    if (!(upstream.ok || upstream.status === 206)) {
      return new Response(`Provider media HTTP ${upstream.status}`, {
        status: upstream.status || 502,
        headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
      });
    }

    return browserMediaResponse(upstream, source.mime);
  } catch (error) {
    return new Response(`Browser media bridge failed: ${error.message}`, {
      status: 502,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || url.pathname !== '/__media/stream') return;
  if (event.request.method !== 'GET') return;
  event.respondWith(handleMedia(event.request, url));
});
