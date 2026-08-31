/* TogetherVideo browser-local media bridge.
 * Video bytes flow directly from the provider CDN to this browser.
 * The TogetherVideo server still only resolves a redirect; it never receives,
 * proxies, buffers, or caches media bytes.
 */
const SOURCE_TTL_MS = 120000;
const RESOLVER_TIMEOUT_MS = 12000;
const PROVIDER_HEADER_TIMEOUT_MS = 15000;
const RANGE_CHUNK_BYTES = 16 * 1024 * 1024;
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

function boundedMediaRange(rawRange) {
  const raw = String(rawRange || '').trim();
  if (!raw) return `bytes=0-${RANGE_CHUNK_BYTES - 1}`;

  // Media elements normally ask for one byte range. Keep unusual/multipart
  // requests unchanged rather than trying to reinterpret them here.
  const match = /^bytes=(\d+)-(\d*)$/i.exec(raw);
  if (!match) return raw;

  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : NaN;
  if (!Number.isSafeInteger(start) || start < 0) return raw;

  const maxEnd = start + RANGE_CHUNK_BYTES - 1;
  if (Number.isSafeInteger(requestedEnd) && requestedEnd >= start) {
    return `bytes=${start}-${Math.min(requestedEnd, maxEnd)}`;
  }
  return `bytes=${start}-${maxEnd}`;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 12000, parentSignal = null) {
  const controller = new AbortController();
  const abortFromParent = () => {
    try { controller.abort(parentSignal?.reason || new Error('media request cancelled')); } catch {}
  };

  if (parentSignal?.aborted) abortFromParent();
  else parentSignal?.addEventListener?.('abort', abortFromParent, { once: true });

  const timer = setTimeout(() => {
    try { controller.abort(new Error('media request timeout')); } catch {}
  }, timeoutMs);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    // fetch() resolves when response headers arrive. Do not abort the streaming
    // body after that point; the browser/request signal remains linked so an old
    // seek/download can still be cancelled when the media element abandons it.
    clearTimeout(timer);
  }
}

async function resolveProviderUrl(mediaPath, fresh = false) {
  const now = Date.now();
  const cached = sourceCache.get(mediaPath);
  if (!fresh && cached && cached.expiresAt > now) return cached;

  // Reuse the existing no-proxy /api/media route. The private marker prevents
  // this Service Worker from intercepting its own resolver request.
  const resolver = new URL('/api/media', self.location.origin);
  resolver.searchParams.set('path', mediaPath);
  resolver.searchParams.set('_swresolve', '1');
  if (fresh) resolver.searchParams.set('_fresh', String(now));

  let lastStatus = 0;
  for (const method of ['HEAD', 'GET']) {
    const options = {
      method,
      credentials: 'same-origin',
      redirect: 'follow',
      cache: 'no-store',
      headers: method === 'GET' ? { Range: 'bytes=0-0' } : {},
    };

    try {
      const response = await fetchWithTimeout(resolver, options, RESOLVER_TIMEOUT_MS);
      lastStatus = response.status;
      const finalUrl = response.url ? new URL(response.url) : null;
      const reachedProvider = finalUrl && finalUrl.origin !== self.location.origin;
      const usable = response.ok || response.status === 206;
      await response.body?.cancel().catch(() => {});

      if (usable && reachedProvider) {
        const source = {
          url: finalUrl.toString(),
          mime: mimeForPath(mediaPath),
          expiresAt: now + SOURCE_TTL_MS,
        };
        sourceCache.set(mediaPath, source);
        return source;
      }
    } catch (error) {
      if (method === 'GET') throw error;
    }
  }

  throw new Error(`media resolver HTTP ${lastStatus || 0}`);
}

async function providerFetch(request, source) {
  const headers = new Headers();
  // Do not turn an unbounded media request (bytes=N-) into a download of the
  // entire remainder of a multi-gigabyte movie. Give the browser a bounded 16MiB
  // chunk; it can request the next chunk when playback actually needs it.
  headers.set('Range', boundedMediaRange(request.headers.get('range')));

  return fetchWithTimeout(source.url, {
    method: 'GET',
    headers,
    mode: 'cors',
    credentials: 'omit',
    redirect: 'follow',
    cache: 'no-store',
  }, PROVIDER_HEADER_TIMEOUT_MS, request.signal);
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
    // A watchdog retry marks the browser-facing request with _fresh=1. In that
    // case bypass this browser's cached signed CDN URL and resolve a new one.
    const forceFresh = requestUrl.searchParams.get('_fresh') === '1';
    let source = await resolveProviderUrl(mediaPath, forceFresh);
    let upstream = await providerFetch(request, source);

    // Long movies may outlive a signed CDN URL. Resolve once more and repeat the
    // exact logical Range instead of pushing an expired URL back to the <video> element.
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
