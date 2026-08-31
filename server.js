const crypto = require('crypto');
const http = require('http');
const path = require('path');
const express = require('express');
const compression = require('compression');
const cookieSession = require('cookie-session');
const helmet = require('helmet');
const { Server } = require('socket.io');

const config = require('./src/config');
const { SettingsStore } = require('./src/settings');
const { WebDavClient, WebDavError } = require('./src/webdav');
const { WatchRoom, cleanMediaPath } = require('./src/watch-room');

const VIDEO_EXTENSIONS = new Set(['.mp4', '.m4v', '.webm', '.mov', '.ogv', '.ogg', '.mkv']);
const MEDIA_MIME = new Map([
  ['.mp4', 'video/mp4'],
  ['.m4v', 'video/x-m4v'],
  ['.mov', 'video/quicktime'],
  ['.webm', 'video/webm'],
  ['.ogv', 'video/ogg'],
  ['.ogg', 'video/ogg'],
  ['.mkv', 'video/x-matroska'],
]);
const PLAYABLE_CACHE_TTL_MS = 10_000;
const BUFFERING_PAUSE_DELAY_MS = 1500;
const BUFFERING_RESUME_DELAY_MS = 800;

function cleanName(value) {
  return String(value || '访客').trim().replace(/[<>]/g, '').slice(0, 20) || '访客';
}

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

  const participants = new Map();
  const playableCache = new Map();
  let bufferingPauseTimer = null;
  let bufferingResumeTimer = null;
  let bufferingHold = null;

  function participantList() {
    return [...participants.entries()].map(([id, item]) => ({
      id,
      nickname: item.nickname,
      buffering: [...item.buffering.values()].some(Boolean),
    }));
  }

  function broadcastPresence() {
    io.emit('presence:update', { participants: participantList(), limit: 2 });
  }

  function hasBufferingParticipant() {
    if (participants.size < 2) return false;
    return [...participants.values()].some((item) => [...item.buffering.values()].some(Boolean));
  }

  function clearPauseTimer() {
    clearTimeout(bufferingPauseTimer);
    bufferingPauseTimer = null;
  }

  function clearResumeTimer() {
    clearTimeout(bufferingResumeTimer);
    bufferingResumeTimer = null;
  }

  function coordinateBuffering() {
    const current = room.snapshot();
    if (bufferingHold && current.revision !== bufferingHold.revision) bufferingHold = null;

    if (hasBufferingParticipant()) {
      clearResumeTimer();
      if (bufferingHold || bufferingPauseTimer || !current.media || !current.playing) return;

      bufferingPauseTimer = setTimeout(() => {
        bufferingPauseTimer = null;
        if (!hasBufferingParticipant()) return;
        const before = room.snapshot();
        if (!before.media || !before.playing) return;

        const paused = room.apply('wait', {}, '缓冲保护');
        if (!paused) return;
        bufferingHold = { revision: paused.revision, mediaVersion: paused.mediaVersion };
        io.emit('room:state', paused);
        io.emit('room:buffering-hold', { message: '对方持续缓冲，已暂时一起暂停' });
      }, BUFFERING_PAUSE_DELAY_MS);
      return;
    }

    clearPauseTimer();
    if (!bufferingHold || bufferingResumeTimer) return;

    bufferingResumeTimer = setTimeout(() => {
      bufferingResumeTimer = null;
      if (hasBufferingParticipant() || !bufferingHold) return;

      const hold = bufferingHold;
      const before = room.snapshot();
      bufferingHold = null;
      if (
        !before.media
        || before.playing
        || before.mediaVersion !== hold.mediaVersion
        || before.revision !== hold.revision
      ) return;

      const resumed = room.apply('play', {
        mediaPath: before.media.path,
        mediaVersion: before.mediaVersion,
        position: before.position,
      }, '缓冲恢复');
      if (!resumed) return;
      io.emit('room:state', resumed);
      io.emit('room:buffering-resume', { message: '双方已就绪，继续播放' });
    }, BUFFERING_RESUME_DELAY_MS);
  }

  function requireAuth(req, res, next) {
    if (req.session?.authenticated) return next();
    res.status(401).json({ ok: false, error: '请先登录' });
  }

  function currentWebDav() {
    const webdav = settings.webdav();
    if (!webdav.url || !webdav.username || !webdav.password) {
      throw new WebDavError('请先在设置中完整配置 WebDAV', 400, 'WEBDAV_NOT_CONFIGURED');
    }
    return new WebDavClient(webdav);
  }

  async function resolvePlayable(mediaPath) {
    const now = Date.now();
    const cached = playableCache.get(mediaPath);
    if (cached && cached.expiresAt > now) return cached.playable;
    if (cached) playableCache.delete(mediaPath);

    const playable = await currentWebDav().resolvePlayable(mediaPath);
    playableCache.set(mediaPath, { playable, expiresAt: now + PLAYABLE_CACHE_TTL_MS });
    if (playableCache.size > 100) {
      for (const [key, value] of playableCache) {
        if (value.expiresAt <= now) playableCache.delete(key);
      }
      while (playableCache.size > 100) playableCache.delete(playableCache.keys().next().value);
    }
    return playable;
  }

  async function inspectPlayable(mediaPath) {
    const playable = await resolvePlayable(mediaPath);
    const destination = new URL(playable.url);
    let last = null;

    for (const method of ['HEAD', 'GET']) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      try {
        const response = await fetch(destination, {
          method,
          headers: method === 'GET' ? { Range: 'bytes=0-0' } : {},
          redirect: 'follow',
          signal: controller.signal,
        });
        const contentRange = response.headers.get('content-range') || '';
        const totalMatch = contentRange.match(/\/(\d+)$/);
        last = {
          ok: response.ok || response.status === 206,
          status: response.status,
          method,
          finalHost: (() => { try { return new URL(response.url || destination).hostname; } catch { return destination.hostname; } })(),
          finalProtocol: (() => { try { return new URL(response.url || destination).protocol; } catch { return destination.protocol; } })(),
          contentType: response.headers.get('content-type') || '',
          acceptRanges: response.headers.get('accept-ranges') || '',
          contentRange,
          contentLength: Number(totalMatch?.[1] || response.headers.get('content-length') || 0),
          contentDisposition: response.headers.get('content-disposition') || '',
          rangeSupported: response.status === 206
            || /bytes/i.test(response.headers.get('accept-ranges') || '')
            || /^bytes\s/i.test(contentRange),
          strategy: playable.strategy,
        };
        await response.body?.cancel().catch(() => {});
        if (last.ok) return last;
      } catch (error) {
        last = { ok: false, status: 0, method, error: error.name === 'AbortError' ? 'timeout' : error.message };
      } finally {
        clearTimeout(timer);
      }
    }

    return last || { ok: false, status: 0, error: 'probe-failed' };
  }

  app.get('/healthz', (_req, res) => res.json({ ok: true, version: '3.0.0' }));

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
      playableCache.clear();
      const snapshot = room.apply('clear', {}, req.session.nickname || '设置');
      bufferingHold = null;
      clearPauseTimer();
      clearResumeTimer();
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
      const result = await currentWebDav().list(String(req.query.path || ''));
      const items = result.items
        .filter((item) => item.isDir || VIDEO_EXTENSIONS.has(path.extname(item.name).toLowerCase()))
        .map((item) => ({ ...item, path: item.relativePath }))
        .sort((a, b) => a.isDir !== b.isDir
          ? (a.isDir ? -1 : 1)
          : a.name.localeCompare(b.name, 'zh-CN', { numeric: true, sensitivity: 'base' }));
      res.set('Cache-Control', 'no-store');
      res.json({ ok: true, path: result.relativePath || '', items });
    } catch (error) { next(error); }
  });

  app.get('/api/media/check', async (req, res, next) => {
    try {
      const mediaPath = cleanMediaPath(req.query.path);
      if (!mediaPath) return res.status(400).json({ ok: false, error: '缺少视频路径' });
      const extension = path.extname(mediaPath).toLowerCase();
      if (!VIDEO_EXTENSIONS.has(extension)) {
        return res.status(400).json({ ok: false, error: '该文件不是支持的视频类型' });
      }
      const probe = await inspectPlayable(mediaPath);
      res.set('Cache-Control', 'no-store');
      res.json({
        ok: true,
        media: {
          extension,
          expectedMime: MEDIA_MIME.get(extension) || '',
          mobilePreferred: extension === '.mp4' || extension === '.m4v' || extension === '.mov',
        },
        probe,
      });
    } catch (error) { next(error); }
  });

  app.get('/api/media', async (req, res, next) => {
    try {
      const mediaPath = cleanMediaPath(req.query.path);
      if (!mediaPath) return res.status(400).json({ ok: false, error: '缺少视频路径' });
      const extension = path.extname(mediaPath).toLowerCase();
      if (!VIDEO_EXTENSIONS.has(extension)) {
        return res.status(400).json({ ok: false, error: '该文件不是支持的视频类型' });
      }
      const playable = await resolvePlayable(mediaPath);
      const destination = new URL(playable.url);
      if (!['http:', 'https:'].includes(destination.protocol)) {
        throw new WebDavError('WebDAV 返回了浏览器无法使用的播放协议', 502, 'WEBDAV_BAD_DIRECT_URL');
      }
      if (req.secure && destination.protocol === 'http:') {
        throw new WebDavError('WebDAV 只返回 HTTP 视频直链，而当前网站是 HTTPS；浏览器会阻止混合内容播放。请使用 HTTPS WebDAV/直链。', 409, 'WEBDAV_MIXED_CONTENT');
      }
      res.set('Cache-Control', 'private, no-store');
      res.set('Referrer-Policy', 'no-referrer');
      res.set('X-TogetherVideo-Media-Mode', 'browser-direct');
      res.set('X-TogetherVideo-Media-Strategy', playable.strategy || 'direct');
      res.status(307).set('Location', destination.toString()).end();
    } catch (error) { next(error); }
  });

  io.use((socket, next) => (
    socket.request.session?.authenticated ? next() : next(new Error('unauthorized'))
  ));

  io.on('connection', (socket) => {
    const session = socket.request.session || {};
    const participantId = String(session.participantId || crypto.randomUUID());
    const nickname = cleanName(session.nickname);
    const isExisting = participants.has(participantId);
    if (!isExisting && participants.size >= 2) {
      socket.emit('room:full', { message: '当前已有两个人在线' });
      return setTimeout(() => socket.disconnect(true), 100);
    }

    if (!participants.has(participantId)) {
      participants.set(participantId, { nickname, sockets: new Set(), buffering: new Map() });
    }
    const participant = participants.get(participantId);
    participant.nickname = nickname;
    participant.sockets.add(socket.id);
    participant.buffering.set(socket.id, false);
    socket.data.participantId = participantId;
    socket.data.nickname = nickname;

    socket.emit('room:snapshot', room.snapshot());
    broadcastPresence();
    coordinateBuffering();

    socket.on('sync:request', (ack = () => {}) => {
      if (typeof ack !== 'function') return;
      const snapshot = room.snapshot();
      ack({ ...snapshot, reason: 'sync' });
    });

    socket.on('presence:buffering', (payload = {}) => {
      const current = participants.get(participantId);
      if (!current) return;
      current.buffering.set(socket.id, Boolean(payload.buffering));
      broadcastPresence();
      coordinateBuffering();
    });

    const apply = (action, payload = {}, options = {}) => {
      const snapshot = room.apply(action, payload, nickname);
      if (snapshot) {
        if (options.noSelfEcho) {
          socket.emit('room:state', { ...snapshot, reason: `${snapshot.reason}-ack` });
          socket.broadcast.emit('room:state', snapshot);
        } else {
          io.emit('room:state', snapshot);
        }
        coordinateBuffering();
      }
    };

    socket.on('media:select', (payload = {}) => {
      const mediaPath = cleanMediaPath(payload.mediaPath);
      if (!mediaPath || !VIDEO_EXTENSIONS.has(path.extname(mediaPath).toLowerCase())) return;
      apply('select', { mediaPath, mediaName: payload.mediaName });
    });
    socket.on('player:play', (payload = {}) => apply('play', payload));
    socket.on('player:pause', (payload = {}) => apply('pause', payload));
    socket.on('player:seek', (payload = {}) => apply('seek', payload, { noSelfEcho: true }));
    socket.on('player:rate', (payload = {}) => apply('rate', payload));
    socket.on('player:wait', () => {
      const snapshot = room.apply('wait', {}, nickname);
      if (snapshot) {
        io.emit('room:state', snapshot);
        io.emit('room:wait', { nickname });
        coordinateBuffering();
      }
    });

    socket.on('disconnect', () => {
      const current = participants.get(participantId);
      if (!current) return;
      current.sockets.delete(socket.id);
      current.buffering.delete(socket.id);
      if (!current.sockets.size) participants.delete(participantId);
      broadcastPresence();
      coordinateBuffering();
    });
  });

  const libmediaAvPlayerDir = path.join(process.cwd(), 'node_modules', '@libmedia', 'avplayer', 'dist', 'esm');
  app.use('/vendor/libmedia/avplayer', express.static(libmediaAvPlayerDir, {
    etag: true,
    maxAge: '1d',
    setHeaders(res) {
      res.setHeader('Cache-Control', 'public, max-age=86400');
    },
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

  app.use((error, _req, res, _next) => {
    const status = error instanceof WebDavError ? error.status : Number(error.status || 500);
    if (status >= 500) console.error('[http]', error);
    res.status(status).json({
      ok: false,
      error: error.message || '服务器错误',
      code: error.code || undefined,
    });
  });

  server.listen(config.port, config.host, () => {
    console.log(`[TogetherVideo 3.0] listening on ${config.host}:${config.port}`);
    console.log('[TogetherVideo 3.0] fixed two-person room; no room codes');
    console.log('[TogetherVideo 3.0] Safari stays on the native media pipeline; unstable libmedia Safari fallback is disabled');
    console.log('[TogetherVideo 3.0] media recovery freezes seek/rate correction until stable playback is proven');
    console.log('[TogetherVideo 3.0] WebDAV is used only for metadata and direct-link discovery');
    console.log('[TogetherVideo 3.0] media bytes are never proxied by this server');
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
