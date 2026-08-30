const http = require('http');
const path = require('path');
const express = require('express');
const cookieSession = require('cookie-session');
const compression = require('compression');
const helmet = require('helmet');
const { Server } = require('socket.io');

const config = require('./src/config');
const { OpenListClient, OpenListError } = require('./src/openlist');
const JsonStore = require('./src/store');
const { RoomManager, cleanName } = require('./src/rooms');

const VIDEO_EXTENSIONS = new Set(['.mp4', '.m4v', '.webm', '.mov', '.mkv', '.m3u8', '.ts']);

async function main() {
  const store = new JsonStore(config.dataFile);
  await store.init();
  const openlist = new OpenListClient(config.openlist);
  const app = express();
  if (config.trustProxy) app.set('trust proxy', 1);

  const sessionMiddleware = cookieSession({
    name: 'together_session', keys: [config.sessionSecret],
    maxAge: 1000 * 60 * 60 * 24 * 30, sameSite: 'lax', httpOnly: true, secure: config.cookieSecure,
  });

  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' }, contentSecurityPolicy: false }));
  app.use(compression());
  app.use(express.json({ limit: '32kb' }));
  app.use(sessionMiddleware);
  app.get('/healthz', (_req, res) => res.json({ ok: true }));

  app.post('/api/login', (req, res) => {
    const password = String(req.body?.password || '');
    const nickname = cleanName(req.body?.nickname);
    if (!password || password !== config.sitePassword) return res.status(401).json({ ok: false, error: '密码错误' });
    req.session.authenticated = true; req.session.nickname = nickname;
    res.json({ ok: true, nickname, defaultRoom: config.defaultRoom });
  });
  app.post('/api/logout', (req, res) => { req.session = null; res.json({ ok: true }); });
  app.get('/api/session', (req, res) => res.json({ authenticated: Boolean(req.session?.authenticated), nickname: req.session?.nickname || '', defaultRoom: config.defaultRoom }));
  app.use('/api', (req, res, next) => req.session?.authenticated ? next() : res.status(401).json({ ok: false, error: '请先登录' }));

  app.get('/api/library', async (req, res, next) => {
    try {
      const result = await openlist.list(String(req.query.path || ''));
      result.items = result.items
        .filter((item) => item.isDir || VIDEO_EXTENSIONS.has(path.extname(item.name).toLowerCase()))
        .sort((a, b) => a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name, 'zh-CN', { numeric: true, sensitivity: 'base' }));
      res.json({ ok: true, ...result });
    } catch (error) { next(error); }
  });

  app.get('/api/play', async (req, res, next) => {
    try {
      const relativePath = String(req.query.path || '');
      if (!relativePath) return res.status(400).json({ ok: false, error: '缺少视频路径' });
      const playable = await openlist.resolvePlayable(relativePath);
      const headerNames = Object.keys(playable.headers || {});
      if (headerNames.length) console.warn(`[play] OpenList returned provider headers (${headerNames.join(', ')}). Browser direct-play compatibility depends on the provider.`);
      res.set('Cache-Control', 'private, no-store');
      res.redirect(302, playable.url);
    } catch (error) { next(error); }
  });

  app.get('/api/play-info', async (req, res, next) => {
    try {
      const relativePath = String(req.query.path || '');
      if (!relativePath) return res.status(400).json({ ok: false, error: '缺少视频路径' });
      const { data } = await openlist.get(relativePath);
      const ext = path.extname(data?.name || relativePath).toLowerCase();
      res.json({ ok: true, name: data?.name || path.posix.basename(relativePath), extension: ext, size: Number(data?.size || 0), provider: data?.provider || '', playUrl: `/api/play?path=${encodeURIComponent(relativePath)}` });
    } catch (error) { next(error); }
  });

  app.use('/vendor/hls', express.static(path.join(process.cwd(), 'node_modules', 'hls.js', 'dist'), { immutable: true, maxAge: '7d' }));
  app.use(express.static(path.join(process.cwd(), 'public'), { maxAge: '1h' }));
  app.get('*', (_req, res) => res.sendFile(path.join(process.cwd(), 'public', 'index.html')));
  app.use((error, _req, res, _next) => {
    const status = error instanceof OpenListError ? error.status : 500;
    console.error('[http]', error); res.status(status).json({ ok: false, error: error.message || '服务器错误' });
  });

  const server = http.createServer(app);
  const io = new Server(server, { transports: ['websocket', 'polling'], serveClient: true, maxHttpBufferSize: 100_000 });
  io.engine.use(sessionMiddleware);
  io.use((socket, next) => socket.request.session?.authenticated ? next() : next(new Error('unauthorized')));
  new RoomManager({ io, store, defaultRoom: config.defaultRoom, maxRoomUsers: config.maxRoomUsers }).start();

  server.listen(config.port, config.host, () => {
    console.log(`[TogetherVideo] listening on ${config.host}:${config.port}`);
    console.log(`[TogetherVideo] OpenList root: ${config.openlist.root}`);
    console.log('[TogetherVideo] media mode: redirect-only (video bytes are never proxied by this app)');
  });
}

main().catch((error) => { console.error(error); process.exit(1); });
