const crypto = require('crypto');

const STATIC_SALT = 'https://github.com/alist-org/alist';

function staticHash(password) {
  return crypto.createHash('sha256').update(`${password}-${STATIC_SALT}`, 'utf8').digest('hex');
}

function extractQr(status = '') {
  const match = String(status).match(/data:image\/(?:jpeg|jpg|png);base64,([^"'<>\s]+)/i);
  return match ? `data:image/jpeg;base64,${match[1]}` : '';
}

function parseAddition(storage) {
  try { return JSON.parse(storage?.addition || '{}'); } catch { return {}; }
}

class OpenListAdmin {
  constructor({ baseUrl, password = '' }) {
    this.baseUrl = String(baseUrl || 'http://127.0.0.1:5244').replace(/\/$/, '');
    this.password = password;
    this.token = '';
  }

  setPassword(password) { this.password = password || ''; this.token = ''; }

  async raw(endpoint, { method = 'GET', body, auth = false, timeout = 10000 } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const headers = { 'Content-Type': 'application/json' };
    if (auth && this.token) headers.Authorization = this.token;
    try {
      const response = await fetch(`${this.baseUrl}${endpoint}`, {
        method,
        headers,
        body: body == null ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      const json = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(`OpenList HTTP ${response.status}`);
      if (typeof json.code === 'number' && json.code !== 200) throw new Error(json.message || `OpenList code ${json.code}`);
      return json.data;
    } finally { clearTimeout(timer); }
  }

  async health() {
    try { await this.raw('/api/public/settings', { timeout: 2000 }); return true; } catch { return false; }
  }

  async login() {
    if (!this.password) throw new Error('OpenList 内部管理员密码尚未准备好');
    const data = await this.raw('/api/auth/login/hash', {
      method: 'POST',
      body: { username: 'admin', password: staticHash(this.password), otp_code: '' },
    });
    if (!data?.token) throw new Error('无法获取 OpenList 管理 Token');
    this.token = data.token;
    return this.token;
  }

  async getToken(force = false) {
    if (force) this.token = '';
    return this.token || this.login();
  }

  async request(endpoint, options = {}) {
    if (!this.token) await this.login();
    try { return await this.raw(endpoint, { ...options, auth: true }); }
    catch (error) {
      this.token = '';
      await this.login();
      return this.raw(endpoint, { ...options, auth: true });
    }
  }

  async listStorages() {
    const data = await this.request('/api/admin/storage/list');
    if (Array.isArray(data)) return data;
    if (Array.isArray(data?.content)) return data.content;
    return [];
  }

  async getQuark() {
    const storages = await this.listStorages();
    return storages.find((item) => item.driver === 'QuarkTV') || null;
  }

  describe(storage) {
    if (!storage) return { exists: false, ready: false, status: 'not-configured', qr: '', playMode: '' };
    const status = String(storage.status || '');
    const addition = parseAddition(storage);
    return {
      exists: true,
      id: storage.id,
      mountPath: storage.mount_path,
      ready: status === 'work',
      status,
      disabled: Boolean(storage.disabled),
      qr: extractQr(status),
      playMode: addition.link_method || 'download',
    };
  }

  async updateQuarkPlayMode(mode = 'streaming') {
    if (!['download', 'streaming'].includes(mode)) throw new Error('不支持的 QuarkTV 播放模式');
    const storage = await this.getQuark();
    if (!storage) throw new Error('还没有创建 QuarkTV 挂载');
    const addition = parseAddition(storage);
    if ((addition.link_method || 'download') === mode) return this.describe(storage);
    addition.link_method = mode;
    const payload = { ...storage, addition: JSON.stringify(addition) };
    delete payload.mount_details;
    await this.request('/api/admin/storage/update', { method: 'POST', body: payload });
    for (let i = 0; i < 15; i++) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const current = this.describe(await this.getQuark());
      if (current.playMode === mode && current.ready) return current;
    }
    return this.describe(await this.getQuark());
  }

  async ensureStreamingMode() {
    const storage = await this.getQuark();
    if (!storage) return null;
    const current = this.describe(storage);
    if (!current.ready || current.playMode === 'streaming') return current;
    return this.updateQuarkPlayMode('streaming');
  }

  async createQuark() {
    const current = await this.getQuark();
    if (current) return this.describe(current);
    const addition = {
      root_folder_id: '0',
      order_by: 'updated_at',
      order_direction: 'desc',
      refresh_token: '',
      device_id: '',
      query_token: '',
      link_method: 'streaming',
    };
    await this.request('/api/admin/storage/create', {
      method: 'POST',
      body: {
        mount_path: '/QuarkTV',
        order: 0,
        driver: 'QuarkTV',
        cache_expiration: 30,
        addition: JSON.stringify(addition),
        remark: 'Managed by TogetherVideo',
        disabled: false,
        disable_index: false,
        enable_sign: false,
        order_by: '',
        order_direction: '',
        extract_folder: '',
        web_proxy: false,
        webdav_policy: '302_redirect',
        proxy_range: false,
        down_proxy_url: '',
        disable_proxy_sign: false,
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 600));
    return this.describe(await this.getQuark());
  }

  async finishQuark() {
    const storage = await this.getQuark();
    if (!storage) throw new Error('还没有创建 QuarkTV 挂载');
    const id = Number(storage.id);
    await this.request(`/api/admin/storage/disable?id=${id}`, { method: 'POST' });
    await new Promise((resolve) => setTimeout(resolve, 300));
    await this.request(`/api/admin/storage/enable?id=${id}`, { method: 'POST' });
    for (let i = 0; i < 20; i++) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const current = this.describe(await this.getQuark());
      if (current.ready) {
        if (current.playMode !== 'streaming') return this.updateQuarkPlayMode('streaming');
        return current;
      }
      if (current.qr) return current;
    }
    return this.describe(await this.getQuark());
  }

  async resetQuark() {
    const storage = await this.getQuark();
    if (storage) await this.request(`/api/admin/storage/delete?id=${Number(storage.id)}`, { method: 'POST' });
    await new Promise((resolve) => setTimeout(resolve, 300));
    return this.createQuark();
  }
}

module.exports = OpenListAdmin;
