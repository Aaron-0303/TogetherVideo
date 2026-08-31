/* TogetherVideo browser-local media bridge.
 * Video bytes flow directly from the provider CDN to this browser.
 * The TogetherVideo server still only resolves a redirect; it never receives,
 * proxies, buffers, or caches media bytes.
 */
const SOURCE_TTL_MS = 120000;
const sourceCache = new Map();

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

function mimeForPath(mediaPath) {
  const clean = String(mediaPath || '').split('?')[0].toLowerCase();
  if (clean.endsWith('.mp4')) return 'video/mp4';
  if (clean.endsWith('.m4v')) return 'video/x-m4v';
  if (clean.endsWith('.mov')) return 'video/quicktime';
  if (clean.endsWith('.webm')) return 'video/webm';
  if (clean.endsWith('.ogv') || clean.endsWith('.ogg')) return 'video/ogg';
  if (clean.endsWith('.mkv')) return 'video/x-matroska';
  return 'application/octet-stream';
}

async function resolveProviderUrl(mediaPath, fresh = false) {
  const now = Date.now();
  const cached = sourceCache.get(mediaPath);
  if (!fresh && cached && cached.expiresAt > now) return cached;

  // Reuse the existing no-proxy /api/media route. The private marker prevents
  // this Service Worker from intercepting its own one-byte resolver request.
  const resolver = new URL('/api/media', self.location.origin);
  resolver.searchParams.set('path', mediaPath);
  resolver.searchParams.set('_swresolve', '1');
  if (fresh) resolver.searchParams.set('_fresh', String(now));

  const response = await fetch(resolver, {
    method: 'GET',
    credentials: 'same-origin',
    redirect: 'follow',
    cache: 'no-store',
    headers: { Range: 'bytes=0-0' },
  });

  // The resolver follows TogetherVideo's 307 in this browser, so the final URL
  // is the provider/CDN URL and at most one media byte is requested from it.
  if (!(response.ok || response.status === 206) || !response.url) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`media resolver HTTP ${response.status}`);
  }

  const finalUrl = new URL(response.url);
  if (finalUrl.origin === self.location.origin) {
    await response.body?.cancel().catch(() => {});
    throw new Error('media resolver did not reach provider');
  }

  await response.body?.cancel().catch(() => {});
  const source = {
    url: finalUrl.toString(),
    mime: mimeForPath(mediaPath),
    expiresAt: now + SOURCE_TTL_MS,
  };
  sourceCache.set(mediaPath, source);
  return source;
}

async function providerFetch(request, source) {
  const headers = new Headers();
  // Preserve Safari/Chrome's exact Range. If the first media request contains no
  // Range, bytes=0- still forces the provider into its known-good 206 path.
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
  // Only copy media-safe headers. In particular we intentionally do not copy
  // Content-Disposition: attachment or X-Content-Type-Options: nosniff.
  for (const name of ['content-range', 'content-length', 'accept-ranges', 'etag', 'last-modified']) {
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
    let source = await resolveProviderUrl(mediaPath, false);
    let upstream = await providerFetch(request, source);

    // Long movies may outlive a signed CDN URL. Resolve once more and repeat the
    // exact Range instead of pushing an expired URL back to the <video> element.
    if (upstream.status === 401 || upstream.status === 403) {
      await upstream.body?.cancel().catch(() => {});
      sourceCache.delete(mediaPath);
      source = await resolveProviderUrl(mediaPath, true);
      upstream = await providerFetch(request, source);
    }

    if (!(upstream.ok || upstream.status === 206)) {
      await upstream.body?.cancel().catch(() => {});
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
  if (url.origin !== self.location.origin || url.pathname !== '/api/media') return;
  if (url.searchParams.has('_swresolve')) return;
  if (event.request.method !== 'GET') return;
  event.respondWith(handleMedia(event.request, url));
});
