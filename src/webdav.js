const path = require('path');
const { XMLParser } = require('fast-xml-parser');

class WebDavError extends Error {
  constructor(message, status = 502, code = 'WEBDAV_ERROR', details = null) {
    super(message);
    this.name = 'WebDavError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function normalizeBaseUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) throw new WebDavError('请先配置 WebDAV 地址', 400, 'WEBDAV_NOT_CONFIGURED');
  let url;
  try { url = new URL(raw); } catch { throw new WebDavError('WebDAV 地址格式不正确', 400, 'WEBDAV_BAD_URL'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new WebDavError('WebDAV 只支持 http/https 地址', 400, 'WEBDAV_BAD_URL');
  url.hash = '';
  url.search = '';
  url.username = '';
  url.password = '';
  return url.toString().replace(/\/$/, '');
}

function normalizeRoot(value) {
  let root = String(value || '/').trim().replace(/\\/g, '/');
  if (!root.startsWith('/')) root = `/${root}`;
  root = path.posix.normalize(root);
  return root === '.' ? '/' : root;
}

function cleanRelative(value = '') {
  const raw = String(value || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const normalized = path.posix.normalize(raw || '.');
  if (normalized === '.') return '';
  if (normalized === '..' || normalized.startsWith('../')) throw new WebDavError('非法 WebDAV 路径', 400, 'WEBDAV_BAD_PATH');
  return normalized.replace(/^\/+/, '');
}

function authHeader(username, password) {
  if (!username && !password) return '';
  return `Basic ${Buffer.from(`${username || ''}:${password || ''}`, 'utf8').toString('base64')}`;
}

function asArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function bestProp(response) {
  for (const propstat of asArray(response?.propstat)) {
    if (String(propstat?.status || '').includes(' 200 ')) return propstat?.prop || {};
  }
  return asArray(response?.propstat)[0]?.prop || {};
}

class WebDavClient {
  constructor(options = {}) {
    this.timeoutMs = Number(options.timeoutMs || 15000);
    this.parser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, trimValues: true });
    this.update(options);
  }

  update(options = {}) {
    this.baseUrl = options.url ? normalizeBaseUrl(options.url) : '';
    this.username = String(options.username || '');
    this.password = String(options.password || '');
    this.root = normalizeRoot(options.root || '/');
  }

  configured() { return Boolean(this.baseUrl); }

  buildUrl(relativePath = '') {
    if (!this.baseUrl) throw new WebDavError('请先配置 WebDAV', 400, 'WEBDAV_NOT_CONFIGURED');
    const relative = cleanRelative(relativePath);
    const url = new URL(this.baseUrl);
    const baseSegments = url.pathname.split('/').filter(Boolean).map((part) => decodeURIComponent(part));
    const rootSegments = this.root.split('/').filter(Boolean);
    const relativeSegments = relative.split('/').filter(Boolean);
    const segments = [...baseSegments, ...rootSegments, ...relativeSegments].map((part) => encodeURIComponent(part));
    url.pathname = `/${segments.join('/')}`;
    return url.toString();
  }

  headers(extra = {}) {
    const headers = { ...extra };
    const auth = authHeader(this.username, this.password);
    if (auth) headers.Authorization = auth;
    return headers;
  }

  async fetchWithTimeout(url, options = {}, timeoutMs = this.timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } catch (error) {
      if (error.name === 'AbortError') throw new WebDavError('WebDAV 请求超时', 504, 'WEBDAV_TIMEOUT');
      if (error instanceof WebDavError) throw error;
      throw new WebDavError(`无法连接 WebDAV：${error.message}`, 502, 'WEBDAV_CONNECT_FAILED');
    } finally {
      clearTimeout(timer);
    }
  }

  checkStatus(response) {
    if (response.status === 401 || response.status === 403) {
      throw new WebDavError('WebDAV 用户名或密码错误，或没有访问权限', 401, 'WEBDAV_AUTH_FAILED');
    }
    if (response.status === 404) throw new WebDavError('WebDAV 路径不存在', 404, 'WEBDAV_NOT_FOUND');
    if (!response.ok && response.status !== 207) {
      throw new WebDavError(`WebDAV 返回 HTTP ${response.status}`, 502, 'WEBDAV_HTTP_ERROR');
    }
  }

  async propfind(relativePath = '', depth = 1) {
    const url = this.buildUrl(relativePath);
    const body = `<?xml version="1.0" encoding="utf-8"?>\n<d:propfind xmlns:d="DAV:"><d:prop><d:displayname/><d:resourcetype/><d:getcontentlength/><d:getcontenttype/><d:getlastmodified/></d:prop></d:propfind>`;
    const response = await this.fetchWithTimeout(url, {
      method: 'PROPFIND',
      headers: this.headers({ Depth: String(depth), 'Content-Type': 'application/xml; charset=utf-8' }),
      body,
      redirect: 'follow',
    });
    this.checkStatus(response);
    const xml = await response.text();
    let parsed;
    try { parsed = this.parser.parse(xml); }
    catch { throw new WebDavError('WebDAV 返回的目录数据无法解析', 502, 'WEBDAV_BAD_XML'); }
    return { url, responses: asArray(parsed?.multistatus?.response) };
  }

  async test() {
    const { responses } = await this.propfind('', 0);
    return { ok: true, message: responses.length ? 'WebDAV 连接成功' : 'WebDAV 已响应' };
  }

  async list(relativePath = '') {
    const relative = cleanRelative(relativePath);
    const { url, responses } = await this.propfind(relative, 1);
    const requestedPath = decodeURIComponent(new URL(url).pathname).replace(/\/+$/, '') || '/';
    const items = [];

    for (const response of responses) {
      const href = String(response?.href || '');
      let hrefPath = '';
      try { hrefPath = decodeURIComponent(new URL(href, this.baseUrl).pathname).replace(/\/+$/, '') || '/'; }
      catch { continue; }
      if (hrefPath === requestedPath) continue;

      const prop = bestProp(response);
      const fallbackName = hrefPath.split('/').filter(Boolean).pop() || '';
      const name = String(prop.displayname || fallbackName).trim();
      if (!name || name === '.' || name === '..') continue;
      const resourceType = prop.resourcetype || {};
      const isDir = Object.prototype.hasOwnProperty.call(resourceType, 'collection');
      const childRelative = cleanRelative(relative ? `${relative}/${name}` : name);
      items.push({
        name,
        relativePath: childRelative,
        isDir,
        size: Number(prop.getcontentlength || 0),
        contentType: String(prop.getcontenttype || ''),
        modified: String(prop.getlastmodified || ''),
      });
    }
    return { relativePath: relative, items };
  }

  async probeDirect(relativePath, method) {
    const url = this.buildUrl(relativePath);
    const headers = this.headers(method === 'GET' ? { Range: 'bytes=0-0' } : {});
    const response = await this.fetchWithTimeout(url, { method, headers, redirect: 'manual' });
    if (response.status === 401 || response.status === 403) this.checkStatus(response);

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      await response.body?.cancel().catch(() => {});
      if (!location) throw new WebDavError('WebDAV 返回了重定向但没有 Location', 502, 'WEBDAV_BAD_REDIRECT');
      return new URL(location, url).toString();
    }

    await response.body?.cancel().catch(() => {});
    return '';
  }

  async resolvePlayable(relativePath) {
    const relative = cleanRelative(relativePath);
    const webdavUrl = this.buildUrl(relative);

    if (!this.username && !this.password) return { url: webdavUrl, strategy: 'direct-webdav' };

    let directUrl = '';
    try { directUrl = await this.probeDirect(relative, 'HEAD'); }
    catch (error) { if (error.code === 'WEBDAV_AUTH_FAILED') throw error; }
    if (!directUrl) directUrl = await this.probeDirect(relative, 'GET');

    if (!directUrl) {
      throw new WebDavError(
        '这个 WebDAV 需要账号认证，但文件请求没有返回可供浏览器直连的 302 地址。为保证自建服务器不代理视频，TogetherVideo 不会中转该文件。请使用会返回 302/直链的 123 云盘 WebDAV 或无需认证的 WebDAV 播放地址。',
        409,
        'WEBDAV_NO_BROWSER_DIRECT_URL',
      );
    }

    return { url: directUrl, strategy: 'webdav-redirect' };
  }
}

module.exports = { WebDavClient, WebDavError, normalizeBaseUrl, normalizeRoot, cleanRelative };
