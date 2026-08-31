const crypto = require('crypto');
const { WebDavClient, WebDavError } = require('./webdav');
const { cleanName } = require('./identity');

const MEDIA_BRIDGE_WORKER = `
const SOURCE_TTL_MS = 90000;
const RANGE_CHUNK_BYTES = 16 * 1024 * 1024;
const sourceCache = new Map();

self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (event) { event.waitUntil(self.clients.claim()); });

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
  if (!raw) return 'bytes=0-' + String(RANGE_CHUNK_BYTES - 1);

  const match = /^bytes=(\\d+)-(\\d*)$/i.exec(raw);
  if (!match) return raw;

  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : NaN;
  if (!Number.isSafeInteger(start) || start < 0) return raw;

  const maxEnd = start + RANGE_CHUNK_BYTES - 1;
  if (Number.isSafeInteger(requestedEnd) && requestedEnd >= start) {
    return 'bytes=' + String(start) + '-' + String(Math.min(requestedEnd, maxEnd));
  }
  return 'bytes=' + String(start) + '-' + String(maxEnd);
}

async function resolveProviderUrl(mediaPath, fresh) {
  const now = Date.now();
  const cached = sourceCache.get(mediaPath);
  if (!fresh && cached && cached.expiresAt > now) return cached.url;

  const resolver = new URL('/api/media/url', self.location.origin);
  resolver.searchParams.set('path', mediaPath);
  if (fresh) resolver.searchParams.set('_fresh', String(now));

  const response = await fetch(resolver, {
    method: 'GET',
    credentials: 'same-origin',
    redirect: 'follow',
    cache: 'no-store',
    headers: { Accept: 'application/json' },
  });
  const data = await response.json().catch(function () { return {}; });
  if (!response.ok || data.ok === false || !data.url) {
    throw new Error(data.error || ('media resolver HTTP ' + response.status));
  }

  sourceCache.set(mediaPath, { url: data.url, expiresAt: now + SOURCE_TTL_MS });
  return data.url;
}

function providerHeaders(request) {
  const headers = new Headers();
  // Some browsers start media loading with no Range header, while others use
  // an open-ended bytes=N- request. Passing either form straight to 123 can
  // produce a 200 response for the entire multi-gigabyte object. That regressed
  // metadata discovery for MP4 files whose moov atom is not at the beginning.
  // Keep the browser's requested start offset, but cap each provider fetch to a
  // 16 MiB window. This is the known-good 3.1.2 transport behavior.
  headers.set('Range', boundedMediaRange(request.headers.get('range')));
  const ifRange = request.headers.get('if-range');
  if (ifRange) headers.set('If-Range', ifRange);
  return headers;
}

async function fetchProvider(request, providerUrl) {
  return fetch(providerUrl, {
    method: 'GET',
    headers: providerHeaders(request),
    mode: 'cors',
    credentials: 'omit',
    redirect: 'follow',
    cache: 'no-store',
    signal: request.signal,
  });
}

function normalizedMediaResponse(upstream, mediaPath) {
  const headers = new Headers();
  ['content-range', 'content-length', 'accept-ranges', 'etag', 'last-modified'].forEach(function (name) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  });

  headers.set('Content-Type', mimeForPath(mediaPath));
  headers.set('Content-Disposition', 'inline');
  headers.set('Accept-Ranges', 'bytes');
  headers.set('Cache-Control', 'private, no-store');
  headers.set('X-TogetherVideo-Media-Mode', 'mime-bridge');

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: headers,
  });
}

async function handleMedia(request, requestUrl) {
  const mediaPath = requestUrl.searchParams.get('path') || '';
  if (!mediaPath) return new Response('Missing media path', { status: 400 });

  try {
    let providerUrl = await resolveProviderUrl(mediaPath, false);
    let upstream = await fetchProvider(request, providerUrl);

    if (upstream.status === 401 || upstream.status === 403) {
      if (upstream.body) await upstream.body.cancel().catch(function () {});
      sourceCache.delete(mediaPath);
      providerUrl = await resolveProviderUrl(mediaPath, true);
      upstream = await fetchProvider(request, providerUrl);
    }

    if (!(upstream.ok || upstream.status === 206)) {
      if (upstream.body) await upstream.body.cancel().catch(function () {});
      return new Response('Provider media HTTP ' + upstream.status, {
        status: upstream.status || 502,
        headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
      });
    }

    return normalizedMediaResponse(upstream, mediaPath);
  } catch (error) {
    return new Response('Browser media bridge failed: ' + error.message, {
      status: 502,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }
}

self.addEventListener('fetch', function (event) {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || url.pathname !== '/api/media') return;
  if (event.request.method !== 'GET') return;
  event.respondWith(handleMedia(event.request, url));
});
`;

function registerHttpRoutes(options = {}) {
  const {
    app,
    io,
    settings,
    room,
    mediaService,
    coordinator,
    appVersion,
  } = options;

  function requireAuth(req, res, next) {
    if (req.session?.authenticated) return next();
    res.status(401).json({ ok: false, error: '请先登录' });
  }

  function checkedMediaPath(value) {
    const mediaPath = mediaService.cleanMediaPath(value);
    if (!mediaPath) return { error: '缺少视频路径' };
    if (!mediaService.isSupportedPath(mediaPath)) return { error: '该文件不是支持的视频类型' };
    return { mediaPath };
  }

  async function resolveBrowserDestination(req, mediaPath) {
    // Every browser gets a fresh provider URL. The WebDAV credential remains on
    // the server; only the final anonymous/signed media URL is returned.
    const playable = await mediaService.resolvePlayable(mediaPath, { fresh: true });
    const destination = new URL(playable.url);
    if (!['http:', 'https:'].includes(destination.protocol)) {
      throw new WebDavError('WebDAV 返回了浏览器无法使用的播放协议', 502, 'WEBDAV_BAD_DIRECT_URL');
    }
    if (req.secure && destination.protocol === 'http:') {
      throw new WebDavError('WebDAV 只返回 HTTP 视频直链，而当前网站是 HTTPS；浏览器会阻止混合内容播放。请使用 HTTPS WebDAV/直链。', 409, 'WEBDAV_MIXED_CONTENT');
    }
    return { destination, strategy: playable.strategy || 'direct' };
  }

  app.get('/healthz', (_req, res) => res.json({ ok: true, version: appVersion }));

  // Browser-local media compatibility layer. Node only serves the worker and
  // resolves the signed provider URL; video bytes still flow provider -> browser.
  // The worker restores bounded Range windows because several provider/browser
  // combinations otherwise fall back to an unusable whole-file HTTP 200 stream.
  app.get('/sw.js', (_req, res) => {
    res.type('application/javascript');
    res.set('Cache-Control', 'no-store');
    res.set('Service-Worker-Allowed', '/');
    res.send(MEDIA_BRIDGE_WORKER);
  });

  app.post('/api/login', (req, res) => {
    if (!settings.verifySitePassword(req.body?.password)) {
      return res.status(401).json({ ok: false, error: '访问密码错误' });
    }
    req.session.authenticated = true;
    req.session.nickname = cleanName(req.body?.nickname);
    req.session.participantId = req.session.participantId || crypto.randomUUID();
    res.json({
      ok: true,
      nickname: req.session.nickname,
      participantId: req.session.participantId,
      settings: settings.publicSettings(),
    });
  });

  app.post('/api/logout', (req, res) => {
    req.session = null;
    res.json({ ok: true });
  });

  app.get('/api/session', (req, res) => res.json({
    authenticated: Boolean(req.session?.authenticated),
    nickname: req.session?.nickname || '',
    participantId: req.session?.participantId || '',
    settings: settings.publicSettings(),
  }));

  app.use('/api', requireAuth);

  app.get('/api/settings', (_req, res) => res.json({ ok: true, settings: settings.publicSettings() }));

  app.post('/api/webdav/test', async (req, res, next) => {
    try {
      const candidate = settings.previewWebDav(req.body || {});
      if (!candidate.url || !candidate.username || !candidate.password) {
        throw new WebDavError('请完整填写 WebDAV 地址、用户名和密码', 400, 'WEBDAV_INCOMPLETE');
      }
      const result = await new WebDavClient(candidate).test();
      res.json({ ok: true, result });
    } catch (error) { next(error); }
  });

  app.put('/api/settings/webdav', async (req, res, next) => {
    try {
      const candidate = settings.previewWebDav(req.body || {});
      if (!candidate.url || !candidate.username || !candidate.password) {
        throw new WebDavError('请完整填写 WebDAV 地址、用户名和密码', 400, 'WEBDAV_INCOMPLETE');
      }
      await new WebDavClient(candidate).test();
      await settings.setWebDav(req.body || {});
      mediaService.clearCache();
      const snapshot = room.apply('clear', {}, req.session.nickname || '设置');
      coordinator.resetBuffering();
      if (snapshot) io.emit('room:state', snapshot);
      res.json({ ok: true, settings: settings.publicSettings() });
    } catch (error) { next(error); }
  });

  app.put('/api/settings/password', async (req, res, next) => {
    try {
      await settings.setSitePassword(req.body?.password);
      res.json({ ok: true });
    } catch (error) { next(error); }
  });

  app.get('/api/library', async (req, res, next) => {
    try {
      const result = await mediaService.list(String(req.query.path || ''));
      res.set('Cache-Control', 'no-store');
      res.json({ ok: true, ...result });
    } catch (error) { next(error); }
  });

  app.get('/api/media/check', async (req, res, next) => {
    try {
      const checked = checkedMediaPath(req.query.path);
      if (checked.error) return res.status(400).json({ ok: false, error: checked.error });
      const probe = await mediaService.inspectPlayable(checked.mediaPath);
      res.set('Cache-Control', 'no-store');
      res.json({
        ok: true,
        media: mediaService.descriptor(checked.mediaPath),
        probe,
      });
    } catch (error) { next(error); }
  });

  // The browser-local worker calls this resolver when it needs a current signed
  // provider URL. WebDAV credentials never leave the server.
  app.get('/api/media/url', async (req, res, next) => {
    try {
      const checked = checkedMediaPath(req.query.path);
      if (checked.error) return res.status(400).json({ ok: false, error: checked.error });
      const { destination, strategy } = await resolveBrowserDestination(req, checked.mediaPath);
      res.set('Cache-Control', 'private, no-store');
      res.set('Referrer-Policy', 'no-referrer');
      res.json({
        ok: true,
        url: destination.toString(),
        strategy,
      });
    } catch (error) { next(error); }
  });

  // Fallback redirect for browsers/pages not yet controlled by the worker.
  app.get('/api/media', async (req, res, next) => {
    try {
      const checked = checkedMediaPath(req.query.path);
      if (checked.error) return res.status(400).json({ ok: false, error: checked.error });
      const { destination, strategy } = await resolveBrowserDestination(req, checked.mediaPath);
      res.set('Cache-Control', 'private, no-store');
      res.set('Referrer-Policy', 'no-referrer');
      res.set('X-TogetherVideo-Media-Mode', 'browser-direct-fallback');
      res.set('X-TogetherVideo-Media-Strategy', strategy);
      res.status(307).set('Location', destination.toString()).end();
    } catch (error) { next(error); }
  });
}

function httpErrorHandler(error, _req, res, _next) {
  const status = error instanceof WebDavError ? error.status : Number(error.status || 500);
  if (status >= 500) console.error('[http]', error);
  res.status(status).json({
    ok: false,
    error: error.message || '服务器错误',
    code: error.code || undefined,
  });
}

module.exports = { registerHttpRoutes, httpErrorHandler };
