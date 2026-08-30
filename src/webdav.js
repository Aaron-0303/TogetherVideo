const path = require('path');
const { XMLParser } = require('fast-xml-parser');

const parser = new XMLParser({
  ignoreAttributes: false,
  removeNSPrefix: true,
  parseTagValue: false,
  trimValues: true,
});

class WebDavError extends Error {
  constructor(message, status = 502, details = null) {
    super(message);
    this.name = 'WebDavError';
    this.status = status;
    this.details = details;
  }
}

function safeDecode(value) {
  try { return decodeURIComponent(value); } catch { return value; }
}

function normalizeRelative(value = '') {
  const raw = String(value || '').trim().replace(/\\/g, '/').replace(/^\/+/, '');
  if (raw.split('/').some((part) => part === '..')) throw new WebDavError('非法 WebDAV 路径', 400);
  const normalized = path.posix.normalize(`/${raw}`).replace(/^\/+/, '');
  return normalized === '.' ? '' : normalized;
}

function normalizePathname(value) {
  const decoded = safeDecode(String(value || '')).replace(/\\/g, '/');
  const normalized = path.posix.normalize(decoded || '/');
  return normalized.length > 1 ? normalized.replace(/\/$/, '') : normalized;
}

function text(value) {
  if (value == null) return '';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (typeof value === 'object' && '#text' in value) return String(value['#text']);
  return '';
}

function firstArray(value) { return Array.isArray(value) ? value : value ? [value] : []; }

class WebDavClient {
  constructor(config = {}) {
    if (!config.url) throw new WebDavError('WebDAV 尚未配置', 400);
    this.base = new URL(config.url);
    this.username = String(config.username || '');
    this.password = String(config.password || '');
    this.root = String(config.root || '/');
    this.timeoutMs = Number(config.timeoutMs || 12000);
  }

  authHeader() {
    return `Basic ${Buffer.from(`${this.username}:${this.password}`, 'utf8').toString('base64')}`;
  }

  urlFor(relativePath = '') {
    const relative = normalizeRelative(relativePath);
    const url = new URL(this.base.toString());
    const basePath = normalizePathname(url.pathname);
    const rootPath = normalizePathname(this.root);
    const fullPath = path.posix.join(basePath, rootPath, relative);
    url.pathname = fullPath;
    url.search = '';
    url.hash = '';
    return url;
  }

  directUrl(relativePath = '') {
    const url = this.urlFor(relativePath);
    url.username = this.username;
    url.password = this.password;
    return url.toString();
  }

  async propfind(relativePath = '', depth = 1) {
    const target = this.urlFor(relativePath);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const body = '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:displayname/><d:resourcetype/><d:getcontentlength/><d:getlastmodified/><d:getcontenttype/></d:prop></d:propfind>';
    try {
      const response = await fetch(target, {
        method: 'PROPFIND',
        headers: {
          Authorization: this.authHeader(),
          Depth: String(depth),
          'Content-Type': 'application/xml; charset=utf-8',
        },
        body,
        signal: controller.signal,
        redirect: 'follow',
      });
      const xml = await response.text().catch(() => '');
      if (response.status === 401 || response.status === 403) {
        throw new WebDavError('WebDAV 认证失败，请检查用户名和应用密码', 400);
      }
      if (response.status === 404) throw new WebDavError('WebDAV 目录不存在，请检查地址和根目录', 400);
      if (!response.ok && response.status !== 207) {
        throw new WebDavError(`WebDAV 请求失败：HTTP ${response.status}`, 502, xml.slice(0, 500));
      }
      let parsed;
      try { parsed = parser.parse(xml); }
      catch (error) { throw new WebDavError(`WebDAV 返回内容无法解析：${error.message}`, 502); }
      const multistatus = parsed?.multistatus;
      const responses = firstArray(multistatus?.response);
      if (!responses.length) throw new WebDavError('WebDAV 没有返回目录信息', 502);
      return { target, responses };
    } catch (error) {
      if (error?.name === 'AbortError') throw new WebDavError('WebDAV 连接超时', 504);
      if (error instanceof WebDavError) throw error;
      throw new WebDavError(`无法连接 WebDAV：${error.message}`, 502);
    } finally {
      clearTimeout(timer);
    }
  }

  responseProp(response) {
    for (const propstat of firstArray(response?.propstat)) {
      const status = text(propstat?.status);
      if (!status || /\s200\s/.test(status)) return propstat?.prop || {};
    }
    return firstArray(response?.propstat)[0]?.prop || {};
  }

  async test() {
    const { target, responses } = await this.propfind('', 0);
    const prop = this.responseProp(responses[0]);
    return {
      ok: true,
      displayName: text(prop.displayname) || path.posix.basename(normalizePathname(target.pathname)) || '/',
      url: `${target.origin}${target.pathname}`,
    };
  }

  async list(relativePath = '') {
    const relative = normalizeRelative(relativePath);
    const { target, responses } = await this.propfind(relative, 1);
    const targetPath = normalizePathname(target.pathname);
    const items = [];

    for (const response of responses) {
      const href = text(response?.href);
      if (!href) continue;
      let hrefPath = '';
      try { hrefPath = normalizePathname(new URL(href, target).pathname); }
      catch { hrefPath = normalizePathname(href); }
      if (hrefPath === targetPath) continue;

      const prop = this.responseProp(response);
      const resourceType = prop?.resourcetype;
      const isDir = Boolean(resourceType && typeof resourceType === 'object' && Object.prototype.hasOwnProperty.call(resourceType, 'collection'));
      let name = text(prop?.displayname).trim();
      if (!name) name = path.posix.basename(hrefPath);
      name = safeDecode(name).replace(/\/$/, '');
      if (!name || name === '.' || name === '..') continue;

      const itemRelative = normalizeRelative(relative ? `${relative}/${name}` : name);
      items.push({
        name,
        path: itemRelative,
        isDir,
        size: Number.parseInt(text(prop?.getcontentlength) || '0', 10) || 0,
        modified: text(prop?.getlastmodified) || '',
        contentType: text(prop?.getcontenttype) || '',
      });
    }

    return { path: relative, items };
  }
}

module.exports = { WebDavClient, WebDavError, normalizeRelative };
