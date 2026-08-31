const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const { normalizeRoot } = require('./path-utils');

function inputError(message, code = 'SETTINGS_INVALID_INPUT') {
  const error = new Error(message);
  error.status = 400;
  error.code = code;
  return error;
}

function normalizeWebDavUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  let url;
  try { url = new URL(raw); }
  catch { throw inputError('WebDAV 地址格式不正确', 'WEBDAV_BAD_URL'); }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw inputError('WebDAV 地址必须使用 http:// 或 https://', 'WEBDAV_BAD_URL');
  }
  url.hash = '';
  url.search = '';
  url.username = '';
  url.password = '';
  url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  return url.toString().replace(/\/$/, url.pathname === '/' ? '/' : '');
}

function makePasswordHash(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const digest = crypto.scryptSync(String(password), salt, 32).toString('hex');
  return `${salt}:${digest}`;
}

function verifyPasswordHash(password, stored) {
  const [salt, hex] = String(stored || '').split(':');
  if (!salt || !hex || !/^[0-9a-f]+$/i.test(hex) || hex.length % 2) return false;
  const expected = Buffer.from(hex, 'hex');
  if (!expected.length) return false;
  const actual = crypto.scryptSync(String(password), salt, expected.length);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

class SettingsStore {
  constructor(file, fallbackSitePassword = 'change-me') {
    this.file = file;
    this.fallbackSitePassword = fallbackSitePassword;
    this.data = null;
    this.writeChain = Promise.resolve();
  }

  async init() {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, 'utf8'));
      this.data = parsed && typeof parsed === 'object' ? parsed : {};
    } catch (error) {
      if (error.code !== 'ENOENT') console.warn('[settings] resetting invalid settings:', error.message);
      this.data = {};
    }
    if (!this.data.sessionSecret) this.data.sessionSecret = crypto.randomBytes(32).toString('base64url');
    if (!this.data.webdav || typeof this.data.webdav !== 'object') {
      this.data.webdav = { url: '', username: '', password: '', root: '/' };
    }
    this.data.webdav.root = normalizeRoot(this.data.webdav.root || '/');
    await this.save();
  }

  save() {
    const snapshot = JSON.stringify(this.data, null, 2);
    const tmp = `${this.file}.tmp`;
    const operation = this.writeChain.then(async () => {
      await fs.writeFile(tmp, snapshot, { encoding: 'utf8', mode: 0o600 });
      await fs.rename(tmp, this.file);
    });
    this.writeChain = operation.catch((error) => console.error('[settings] save failed:', error));
    return operation;
  }

  flush() {
    return this.writeChain;
  }

  get sessionSecret() { return this.data.sessionSecret; }

  verifySitePassword(password) {
    if (this.data.sitePasswordHash) return verifyPasswordHash(password, this.data.sitePasswordHash);
    return String(password || '') === String(this.fallbackSitePassword || 'change-me');
  }

  async setSitePassword(password) {
    const value = String(password || '');
    if (value.length < 6) throw inputError('访问密码至少需要 6 个字符', 'SITE_PASSWORD_TOO_SHORT');
    this.data.sitePasswordHash = makePasswordHash(value);
    await this.save();
  }

  webdav() {
    return { ...this.data.webdav };
  }

  previewWebDav(input = {}) {
    const current = this.webdav();
    return {
      url: normalizeWebDavUrl(input.url != null ? input.url : current.url),
      username: String(input.username != null ? input.username : current.username).trim(),
      password: input.password ? String(input.password) : String(current.password || ''),
      root: normalizeRoot(input.root != null ? input.root : current.root),
    };
  }

  async setWebDav(input = {}) {
    const next = this.previewWebDav(input);
    if (!next.url) throw inputError('请填写 WebDAV 地址', 'WEBDAV_URL_REQUIRED');
    if (!next.username) throw inputError('请填写 WebDAV 用户名', 'WEBDAV_USERNAME_REQUIRED');
    if (!next.password) throw inputError('请填写 WebDAV 密码 / 应用密码', 'WEBDAV_PASSWORD_REQUIRED');
    this.data.webdav = next;
    await this.save();
    return this.publicSettings();
  }

  publicSettings() {
    const webdav = this.webdav();
    return {
      webdav: {
        url: webdav.url || '',
        username: webdav.username || '',
        root: webdav.root || '/',
        passwordSaved: Boolean(webdav.password),
        configured: Boolean(webdav.url && webdav.username && webdav.password),
      },
      sitePasswordChanged: Boolean(this.data.sitePasswordHash),
    };
  }
}

module.exports = { SettingsStore, normalizeRoot, normalizeWebDavUrl };
