const http = require('http');
const path = require('path');
const express = require('express');
const cookieSession = require('cookie-session');
const compression = require('compression');
const helmet = require('helmet');
const { Server } = require('socket.io');

const config = require('./src/config');
const { OpenListClient, OpenListError } = require('./src/openlist');
const OpenListAdmin = require('./src/openlist-admin');
const SettingsStore = require('./src/settings');
const JsonStore = require('./src/store');
const { RoomManager, cleanName } = require('./src/rooms');

const VIDEO_EXTENSIONS = new Set(['.mp4', '.m4v', '.webm', '.mov', '.mkv', '.m3u8', '.ts']);
const PLAY_LINK_TTL_MS = 60_000;

function classifyDelivery(url, fallbackExtension = '') {
  const value = String(url || '').toLowerCase();
  let pathname = value;
  try { pathname = new URL(value).pathname.toLowerCase(); } catch {}
  if (pathname.endsWith('.m3u8') || value.includes('.m3u8?') || value.includes('format=m3u8')) return 'hls';
  if (String(fallbackExtension).toLowerCase() === '.m3u8') return 'hls';
  return 'file';
}

async function main() {
  const store = new JsonStore(config.dataFile);
  await store.init();
  const settings = new SettingsStore(config.settingsFile, {
    mediaRoot: config.openlist.root,
    sessionSecret: process.env.SESSION_SECRET || '',
    passwordChanged: config.sitePassword !== 'change-me',
  });
  await settings.init();

  const openlist = new OpenListClient(config.openlist);
  openlist.setRoot(settings.get('mediaRoot') || config.openlist.root);
  const openlistAdmin = new OpenListAdmin({ baseUrl: config.openlist.baseUrl, password: config.openlistAdminPassword });
  if (config.openlistAdminPassword) {
    openlist.setTokenProvider((force) => openlistAdmin.getToken(force));
    try {
      const migrated = await openlistAdmin.ensureDownloadMode();
      if (migrated?.ready) console.log(`[TogetherVideo] QuarkTV default playback mode: ${migrated.playMode || 'download'}`);
    } catch (error) {
      console.warn('[TogetherVideo] unable to restore QuarkTV download mode:', error.message);
    }
  }

  // Browsers can issue several range/resource requests for the same media URL. Resolving a
  // QuarkTV link on every request is expensive, and compat mode would otherwise repeatedly
  // toggle the OpenList driver. Cache only the short-lived resolved redirect URL, never bytes.
  const playLinkCache = new Map();
  const clearPlayLinkCache = () => playLinkCache.clear();
  async function resolvePlayLink(relativePath, mode) {
    const key = `${openlist.root}\n${mode}\n${relativePath}`;
    const now = Date.now();
    const cached = playLinkCache.get(key);
    if (cached?.value && cached.expiresAt > now) return cached.value;
    if (cached?.promise) return cached.promise;

    const promise = (async () => {
      const requestedMode = mode === 'compat' ? 'streaming' : 'download';
      const resolve = () => openlist.resolvePlayable(relativePath);
      const playable = config.openlistAdminPassword
        ? await openlistAdmin.withPlayMode(requestedMode, resolve)
        : await resolve();
      const extension = path.extname(path.posix.basename(relativePath)).toLowerCase();
      return {
        playable,
        delivery: classifyDelivery(playable.url, extension),
        extension,
      };
    })();

    playLinkCache.set(key, { promise, expiresAt: now + PLAY_LINK_TTL_MS });
    try {
      const value = await promise;
      playLinkCache.set(key, { value, expiresAt: Date.now() + PLAY_LINK_TTL_MS });
      return value;
    } catch (error) {
      playLinkCache.delete(key);
      throw error;
    }
  }

  const app = express();
  if (config.trustProxy) app.set('trust proxy', 1);

  const sessionMiddleware = cookieSession({
    name: 'together_session',
    keys: [settings.get('sessionSecret')],
    maxAge: 1000 * 60 * 60 * 24 * 30,
    sameSite: 'lax',
    httpOnly: true,
    secure: config.cookieSecure,
  });

  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' }, contentSecurityPolicy: false }));
  app.use(compression());
  app.use(express.json({ limit: '64kb' }));
  app.use(sessionMiddleware);
  app.get('/healthz', (_req, res) => res.json({ ok: true, openlistBootstrapError: config.openlistBootstrapError || undefined }));

  app.post('/api/login', (req, res) => {
    const password = String(req.body?.password || '');
    const nickname = cleanName(req.body?.nickname);
    if (!password || !settings.verifyPassword(password, config.sitePassword)) {
      return res.status(401).json({ ok: false, error: '密码错误' });
    }
    req.session.authenticated = true;
    req.session.nickname = nickname;
    res.json({ ok: true, nickname, defaultRoom: config.defaultRoom, passwordChanged: settings.publicSettings().passwordChanged });
  });

  app.post('/api/logout', (req, res) => { req.session = null; res.json({ ok: true }); });
  app.get('/api/session', (req, res) => res.json({
    authenticated: Boolean(req.session?.authenticated),
    nickname: req.session?.nickname || '',
    defaultRoom: config.defaultRoom,
    passwordChanged: settings.publicSettings().passwordChanged,
  }));
  app.use('/api', (req, res, next) => req.session?.authenticated ? next() : res.status(401).json({ ok: false, error: '请先登录' }));

  app.get('/api/setup/status', async (_req, res) => {
    const ready = await openlistAdmin.health();
    let quark = { exists: false, ready: false, status: 'not-configured', qr: '' };
    let adminError = '';
    if (ready && config.openlistAdminPassword) {
      try { quark = openlistAdmin.describe(await openlistAdmin.getQuark()); }
      catch (error) { adminError = error.message; }
    } else if (ready && !config.openlistAdminPassword) {
      adminError = '当前使用外部 OpenList，未提供 OPENLIST_ADMIN_PASSWORD，无法在本站管理 QuarkTV。';
    }
    res.json({
      ok: true,
      openlist: { ready, bootstrapError: config.openlistBootstrapError || '', adminError },
      quark,
      settings: settings.publicSettings(),
      firstRun: !settings.publicSettings().passwordChanged || !quark.ready,
    });
  });

  app.post('/api/setup/quark/start', async (_req, res, next) => {
    try {
      clearPlayLinkCache();
      res.json({ ok: true, quark: await openlistAdmin.createQuark() });
    } catch (error) { next(error); }
  });

  app.post('/api/setup/quark/finish', async (_req, res, next) => {
    try {
      clearPlayLinkCache();
      res.json({ ok: true, quark: await openlistAdmin.finishQuark() });
    } catch (error) { next(error); }
  });

  app.post('/api/setup/quark/reset', async (_req, res, next) => {
    try {
      clearPlayLinkCache();
      res.json({ ok: true, quark: await openlistAdmin.resetQuark() });
    } catch (error) { next(error); }
  });

  app.post('/api/settings', async (req, res, next) => {
    try {
      const result = {};
      if (req.body?.mediaRoot != null) {
        const root = openlist.setRoot(String(req.body.mediaRoot || '/QuarkTV'));
        clearPlayLinkCache();
        await settings.set({ mediaRoot: root });
        result.mediaRoot = root;
      }
      if (req.body?.newPassword) {
        await settings.setPassword(String(req.body.newPassword));
        result.passwordChanged = true;
      }
      res.json({ ok: true, settings: { ...settings.publicSettings(), ...result } });
    } catch (error) { next(error); }
  });

  app.get('/api/library', async (req, res, next) => {
    try {
      const result = await openlist.list(String(req.query.path || ''));
      result.items = result.items
        .filter((item) => item.isDir || VIDEO_EXTENSIONS.has(path.extname(item.name).toLowerCase()))
        .sort((a, b) => a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name, 'zh-CN', { numeric: true, sensitivity: 'base' }));
      res.json({ ok: true, root: openlist.root, ...result });
    } catch (error) { next(error); }
  });

  app.get('/api/play', async (req, res, next) => {
    try {
      const relativePath = String(req.query.path || '');
      if (!relativePath) return res.status(400).json({ ok: false, error: '缺少视频路径' });
      const mode = String(req.query.mode || 'original') === 'compat' ? 'compat' : 'original';
      const { playable } = await resolvePlayLink(relativePath, mode);
      const headerNames = playable.headers && typeof playable.headers === 'object' ? Object.keys(playable.headers) : [];
      if (headerNames.length) console.warn(`[play] provider headers ignored by redirect: ${headerNames.join(', ')}`);
      res.set('Cache-Control', 'private, no-store');
      res.redirect(302, playable.url);
    } catch (error) { next(error); }
  });

  app.get('/api/play-info', async (req, res, next) => {
    try {
      const relativePath = String(req.query.path || '');
      if (!relativePath) return res.status(400).json({ ok: false, error: '缺少视频路径' });
      const mode = String(req.query.mode || 'original') === 'compat' ? 'compat' : 'original';
      const name = path.posix.basename(relativePath);
      const resolved = await resolvePlayLink(relativePath, mode);
      res.json({
        ok: true,
        name,
        extension: resolved.extension,
        delivery: resolved.delivery,
        mode,
        playUrl: `/api/play?path=${encodeURIComponent(relativePath)}&mode=${mode}`,
      });
    } catch (error) { next(error); }
  });

  const publicDir = path.join(process.cwd(), 'public');
  app.use('/vendor/hls', express.static(path.join(process.cwd(), 'node_modules', 'hls.js', 'dist'), { immutable: true, maxAge: '7d' }));
  app.get(['/', '/index.html'], (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.sendFile(path.join(publicDir, 'index.html'));
  });
  app.use(express.static(publicDir, {
    maxAge: 0,
    etag: true,
    setHeaders(res, filePath) {
      if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-store');
      else res.setHeader('Cache-Control', 'no-cache');
    },
  }));
  app.get('*', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.sendFile(path.join(publicDir, 'index.html'));
  });

  app.use((error, _req, res, _next) => {
    const status = error instanceof OpenListError ? error.status : 500;
    console.error('[http]', error);
    res.status(status).json({ ok: false, error: error.message || '服务器错误' });
  });

  const server = http.createServer(app);
  const io = new Server(server, { transports: ['websocket', 'polling'], serveClient: true, maxHttpBufferSize: 100_000 });
  io.engine.use(sessionMiddleware);
  io.use((socket, next) => socket.request.session?.authenticated ? next() : next(new Error('unauthorized')));
  new RoomManager({ io, store, defaultRoom: config.defaultRoom, maxRoomUsers: config.maxRoomUsers }).start();

  server.listen(config.port, config.host, () => {
    console.log(`[TogetherVideo] listening on ${config.host}:${config.port}`);
    console.log(`[TogetherVideo] OpenList: ${config.openlist.baseUrl}, media root: ${openlist.root}`);
    console.log('[TogetherVideo] media mode: original download by default; compat streaming is resolved per client');
    console.log('[TogetherVideo] resolved links are cached briefly; video bytes are never proxied by this app');
    if (!settings.publicSettings().passwordChanged) {
      console.warn('[TogetherVideo] first login password is "change-me"; change it in Settings immediately.');
    }
  });
}

main().catch((error) => { console.error(error); process.exit(1); });