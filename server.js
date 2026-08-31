const http = require('http');
const path = require('path');
const express = require('express');
const compression = require('compression');
const cookieSession = require('cookie-session');
const helmet = require('helmet');
const { Server } = require('socket.io');

const { version: appVersion } = require('./package.json');
const config = require('./src/config');
const { SettingsStore } = require('./src/settings');
const { WatchRoom } = require('./src/watch-room');
const { MediaService } = require('./src/media-service');
const { RoomCoordinator } = require('./src/room-coordinator');
const { registerHttpRoutes, httpErrorHandler } = require('./src/http-routes');
const { registerSocketGateway } = require('./src/socket-gateway');

const MEDIA_BRIDGE_WORKER = `
const SOURCE_TTL_MS = 90000;
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
  const range = request.headers.get('range');
  if (range) headers.set('Range', range);
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

async function main() {
  const settings = new SettingsStore(config.settingsFile, config.sitePassword);
  await settings.init();
  const room = new WatchRoom(config.stateFile);
  await room.init();

  const app = express();
  if (config.trustProxy) app.set('trust proxy', 1);
  app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.use(compression());
  app.use(express.json({ limit: '64kb' }));

  const sessionMiddleware = cookieSession({
    name: 'together_v2',
    keys: [settings.sessionSecret],
    maxAge: 1000 * 60 * 60 * 24 * 30,
    sameSite: 'lax',
    httpOnly: true,
    secure: config.cookieSecure,
  });
  app.use(sessionMiddleware);

  const server = http.createServer(app);
  const io = new Server(server, {
    transports: ['websocket', 'polling'],
    serveClient: true,
    maxHttpBufferSize: 64 * 1024,
  });
  io.engine.use(sessionMiddleware);

  const mediaService = new MediaService(settings);
  const coordinator = new RoomCoordinator({
    io,
    room,
    maxParticipants: config.maxParticipants,
  });

  registerHttpRoutes({
    app,
    io,
    settings,
    room,
    mediaService,
    coordinator,
    appVersion,
  });
  registerSocketGateway({ io, room, coordinator, mediaService });

  // Artplayer remains the UI/control component. The native HTMLVideoElement asks
  // for /api/media, while a browser-local Service Worker forwards its exact Range
  // to 123 and fixes only MIME/attachment response headers. Video bytes never
  // pass through the TogetherVideo server.
  const artplayerDir = path.join(process.cwd(), 'node_modules', 'artplayer', 'dist');
  app.use('/vendor/artplayer', express.static(artplayerDir, {
    etag: true,
    maxAge: '1d',
    setHeaders(res) {
      res.setHeader('Cache-Control', 'public, max-age=86400');
    },
  }));

  app.get('/sw.js', (_req, res) => {
    res.type('application/javascript');
    res.set('Cache-Control', 'no-store');
    res.set('Service-Worker-Allowed', '/');
    res.send(MEDIA_BRIDGE_WORKER);
  });

  const publicDir = path.join(process.cwd(), 'public');
  app.get(['/', '/index.html'], (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.sendFile(path.join(publicDir, 'index.html'));
  });
  app.use(express.static(publicDir, {
    etag: true,
    maxAge: 0,
    setHeaders(res, filePath) {
      res.setHeader('Cache-Control', filePath.endsWith('.html') ? 'no-store' : 'no-cache');
    },
  }));
  app.get('*', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.sendFile(path.join(publicDir, 'index.html'));
  });
  app.use(httpErrorHandler);

  server.listen(config.port, config.host, () => {
    console.log(`[TogetherVideo ${appVersion}] listening on ${config.host}:${config.port}`);
    console.log(`[TogetherVideo ${appVersion}] fixed room; max participants=${config.maxParticipants}`);
    console.log(`[TogetherVideo ${appVersion}] Artplayer UI + native HTMLVideoElement + MIME bridge`);
    console.log(`[TogetherVideo ${appVersion}] media bytes are never proxied by this server`);
  });

  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[TogetherVideo ${appVersion}] ${signal}: shutting down`);
    coordinator.stop();
    for (const socket of io.sockets.sockets.values()) socket.disconnect(true);

    const forceExit = setTimeout(() => process.exit(1), 5000);
    forceExit.unref();
    await Promise.allSettled([settings.flush(), room.flush()]);
    server.close(() => {
      clearTimeout(forceExit);
      process.exit(0);
    });
  }

  process.once('SIGINT', () => { void shutdown('SIGINT'); });
  process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
