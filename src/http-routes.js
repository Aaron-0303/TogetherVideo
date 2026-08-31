const crypto = require('crypto');
const { WebDavClient, WebDavError } = require('./webdav');
const { cleanName } = require('./identity');

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

  app.get('/healthz', (_req, res) => res.json({ ok: true, version: appVersion }));

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

  app.get('/api/media', async (req, res, next) => {
    try {
      const checked = checkedMediaPath(req.query.path);
      if (checked.error) return res.status(400).json({ ok: false, error: checked.error });

      // Resolve a fresh signed provider URL for every browser bootstrap. The
      // browser-local Service Worker owns its own short cache, so sharing one
      // server-side signed URL across two viewers only creates cross-client
      // coupling and can break the viewer who joins later.
      const playable = await mediaService.resolvePlayable(checked.mediaPath, { fresh: true });
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
