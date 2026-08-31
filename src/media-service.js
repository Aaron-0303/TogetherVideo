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

  async resolvePlayable(mediaPath, options = {}) {
    const fresh = Boolean(options.fresh);
    const now = Date.now();

    if (!fresh) {
      const cached = this.playableCache.get(mediaPath);
      if (cached && cached.expiresAt > now) return cached.playable;
      if (cached) this.playableCache.delete(mediaPath);
    }

    const playable = await this.currentWebDav().resolvePlayable(mediaPath);

    if (!fresh) {
      this.playableCache.set(mediaPath, { playable, expiresAt: now + this.cacheTtlMs });
      if (this.playableCache.size > 100) {
        for (const [key, value] of this.playableCache) {
          if (value.expiresAt <= now) this.playableCache.delete(key);
        }
        while (this.playableCache.size > 100) this.playableCache.delete(this.playableCache.keys().next().value);
      }
    }

    return playable;
  }

  async inspectPlayable(mediaPath) {
    const playable = await this.resolvePlayable(mediaPath, { fresh: true });
    const destination = new URL(playable.url);

    async function probe(method, headers = {}) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      try {
        const response = await fetch(destination, {
          method,
          headers,
          redirect: 'follow',
          signal: controller.signal,
        });
        const contentRange = response.headers.get('content-range') || '';
        const totalMatch = contentRange.match(/\/(\d+)$/);
        const result = {
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
          strategy: playable.strategy,
        };
        await response.body?.cancel().catch(() => {});
        return result;
      } catch (error) {
        return {
          ok: false,
          status: 0,
          method,
          error: error.name === 'AbortError' ? 'timeout' : error.message,
          strategy: playable.strategy,
        };
      } finally {
        clearTimeout(timer);
      }
    }

    // HEAD 200 only says the object exists. It does NOT prove that the CDN will
    // honor browser byte-range requests. Always perform a real one-byte GET and
    // require HTTP 206 + Content-Range before reporting Range support.
    const head = await probe('HEAD');
    const range = await probe('GET', { Range: 'bytes=0-0' });
    const rangeVerified = range.status === 206 && /^bytes\s+\d+-\d+\/(?:\d+|\*)$/i.test(range.contentRange || '');

    return {
      ...range,
      ok: Boolean(head.ok || range.ok),
      headStatus: head.status || 0,
      rangeStatus: range.status || 0,
      rangeVerified,
      rangeSupported: rangeVerified,
      contentLength: Number(range.contentLength || head.contentLength || 0),
      contentType: range.contentType || head.contentType || '',
      contentDisposition: range.contentDisposition || head.contentDisposition || '',
      acceptRanges: range.acceptRanges || head.acceptRanges || '',
      finalHost: range.finalHost || head.finalHost || destination.hostname,
      finalProtocol: range.finalProtocol || head.finalProtocol || destination.protocol,
      headContentType: head.contentType || '',
    };
  }
}

module.exports = { MediaService, VIDEO_EXTENSIONS, MEDIA_MIME };
