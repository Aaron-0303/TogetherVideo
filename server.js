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

  registerHttpRoutes({ app, io, settings, room, mediaService, coordinator, appVersion });
  registerSocketGateway({ io, room, coordinator, mediaService });

  const libmediaAvPlayerDir = path.join(process.cwd(), 'node_modules', '@libmedia', 'avplayer', 'dist', 'esm');
  app.use('/vendor/libmedia/avplayer', express.static(libmediaAvPlayerDir, {
    etag: true,
    maxAge: '1d',
    setHeaders(res) { res.setHeader('Cache-Control', 'public, max-age=86400'); },
  }));

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
    console.log(`[TogetherVideo ${appVersion}] restored stable native media pipeline`);
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
