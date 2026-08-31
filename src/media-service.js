const path = require('path');
const { WebDavClient, WebDavError } = require('./webdav');
const { cleanMediaPath } = require('./watch-room');

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

class MediaService {
  constructor(settings, options = {}) {
    this.settings = settings;
    this.cacheTtlMs = Number(options.cacheTtlMs || 10_000);
    this.playableCache = new Map();
  }

  currentWebDav() {
    const webdav = this.settings.webdav();
    if (!webdav.url || !webdav.username || !webdav.password) {
      throw new WebDavError('请先在设置中完整配置 WebDAV', 400, 'WEBDAV_NOT_CONFIGURED');
    }
    return new WebDavClient(webdav);
  }

  clearCache() {
    this.playableCache.clear();
  }

  cleanMediaPath(value) {
    return cleanMediaPath(value);
  }

  isSupportedPath(mediaPath) {
    return VIDEO_EXTENSIONS.has(path.extname(String(mediaPath || '')).toLowerCase());
  }

  descriptor(mediaPath) {
    const extension = path.extname(String(mediaPath || '')).toLowerCase();
    return {
      extension,
      expectedMime: MEDIA_MIME.get(extension) || '',
      mobilePreferred: extension === '.mp4' || extension === '.m4v' || extension === '.mov',
    };
  }

  async list(relativePath = '') {
    const result = await this.currentWebDav().list(relativePath);
    const items = result.items
      .filter((item) => item.isDir || this.isSupportedPath(item.name))
      .map((item) => ({ ...item, path: item.relativePath }))
      .sort((a, b) => a.isDir !== b.isDir
        ? (a.isDir ? -1 : 1)
        : a.name.localeCompare(b.name, 'zh-CN', { numeric: true, sensitivity: 'base' }));
    return { path: result.relativePath || '', items };
  }

  async resolvePlayable(mediaPath) {
    const now = Date.now();
    const cached = this.playableCache.get(mediaPath);
    if (cached && cached.expiresAt > now) return cached.playable;
    if (cached) this.playableCache.delete(mediaPath);

    const playable = await this.currentWebDav().resolvePlayable(mediaPath);
    this.playableCache.set(mediaPath, { playable, expiresAt: now + this.cacheTtlMs });
    if (this.playableCache.size > 100) {
      for (const [key, value] of this.playableCache) {
        if (value.expiresAt <= now) this.playableCache.delete(key);
      }
      while (this.playableCache.size > 100) this.playableCache.delete(this.playableCache.keys().next().value);
    }
    return playable;
  }

  async inspectPlayable(mediaPath) {
    const playable = await this.resolvePlayable(mediaPath);
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
}

module.exports = { MediaService, VIDEO_EXTENSIONS, MEDIA_MIME };
