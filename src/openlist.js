const path = require('path');

class OpenListError extends Error {
  constructor(message, status = 502, details = null) { super(message); this.name = 'OpenListError'; this.status = status; this.details = details; }
}

function normalizeRoot(value) {
  let root = String(value || '/').trim().replace(/\\/g, '/');
  if (!root.startsWith('/')) root = `/${root}`;
  root = path.posix.normalize(root);
  if (root.length > 1) root = root.replace(/\/$/, '');
  return root;
}

class OpenListClient {
  constructor(options) { Object.assign(this, options); this.root = normalizeRoot(this.root); }
  setRoot(root) { this.root = normalizeRoot(root); return this.root; }
  resolveRelative(relative = '') {
    const cleaned = String(relative || '').replace(/\\/g, '/').replace(/^\/+/, '');
    const full = path.posix.normalize(path.posix.join(this.root, cleaned));
    const boundary = this.root === '/' ? '/' : `${this.root}/`;
    if (full !== this.root && !full.startsWith(boundary)) throw new OpenListError('非法媒体路径', 400);
    return full;
  }
  toRelative(fullPath) {
    if (fullPath === this.root) return '';
    const boundary = this.root === '/' ? '/' : `${this.root}/`;
    return fullPath.startsWith(boundary) ? fullPath.slice(boundary.length) : '';
  }
  async request(endpoint, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const headers = { 'Content-Type': 'application/json' };
    if (this.token) headers.Authorization = this.token;
    try {
      const response = await fetch(`${this.baseUrl}${endpoint}`, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal });
      if (!response.ok) throw new OpenListError(`OpenList HTTP ${response.status}`, 502);
      const json = await response.json();
      if (json.code !== 200) throw new OpenListError(json.message || 'OpenList 请求失败', 502, json);
      return json.data;
    } catch (error) {
      if (error.name === 'AbortError') throw new OpenListError('OpenList 请求超时', 504);
      if (error instanceof OpenListError) throw error;
      throw new OpenListError(`无法连接 OpenList：${error.message}`, 502);
    } finally { clearTimeout(timer); }
  }
  async list(relativePath = '') {
    const fullPath = this.resolveRelative(relativePath);
    const data = await this.request('/api/fs/list', { path: fullPath, password: this.pathPassword, page: 1, per_page: 0, refresh: false });
    const content = Array.isArray(data?.content) ? data.content : [];
    const items = content.map((item) => ({
      name: item.name, relativePath: this.toRelative(path.posix.join(fullPath, item.name)), isDir: Boolean(item.is_dir),
      size: Number(item.size || 0), modified: item.modified || null, type: Number(item.type || 0), thumb: item.thumb || '',
    }));
    return { relativePath: this.toRelative(fullPath), items, total: Number(data?.total ?? items.length) };
  }
  async get(relativePath) {
    const fullPath = this.resolveRelative(relativePath);
    const data = await this.request('/api/fs/get', { path: fullPath, password: this.pathPassword });
    return { fullPath, data };
  }
  async resolvePlayable(relativePath) {
    const { fullPath, data } = await this.get(relativePath);
    let rawUrl = String(data?.raw_url || '').trim();
    if (rawUrl.startsWith('//')) rawUrl = `https:${rawUrl}`;
    if (rawUrl.startsWith('/') && this.publicUrl) rawUrl = `${this.publicUrl}${rawUrl}`;
    if (rawUrl.startsWith('/') && !this.publicUrl) throw new OpenListError('OpenList 返回了相对播放地址；请设置 OPENLIST_PUBLIC_URL', 502);
    if (rawUrl) return { url: rawUrl, name: data.name || path.posix.basename(fullPath), provider: data.provider || '', headers: data.header || {}, mode: 'raw-url' };
    if (this.publicUrl) {
      const encoded = fullPath.split('/').map(encodeURIComponent).join('/');
      const sign = data?.sign ? `?sign=${encodeURIComponent(data.sign)}` : '';
      return { url: `${this.publicUrl}/d${encoded}${sign}`, name: data?.name || path.posix.basename(fullPath), provider: data?.provider || '', headers: data?.header || {}, mode: 'openlist-download' };
    }
    throw new OpenListError('OpenList 没有返回可播放直链；请在设置里重新授权 QuarkTV。', 502);
  }
}
module.exports = { OpenListClient, OpenListError };
