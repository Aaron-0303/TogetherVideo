const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

function hashPassword(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

class SettingsStore {
  constructor(file, defaults = {}) {
    this.file = file;
    this.defaults = defaults;
    this.data = null;
    this.writeChain = Promise.resolve();
  }

  async init() {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    try {
      this.data = { ...this.defaults, ...JSON.parse(await fs.readFile(this.file, 'utf8')) };
    } catch {
      this.data = { ...this.defaults };
      await this.save();
    }
    if (!this.data.sessionSecret) {
      this.data.sessionSecret = crypto.randomBytes(32).toString('base64url');
      await this.save();
    }
  }

  save() {
    const tmp = `${this.file}.tmp`;
    const snapshot = JSON.stringify(this.data, null, 2);
    this.writeChain = this.writeChain
      .then(async () => {
        await fs.writeFile(tmp, snapshot);
        await fs.rename(tmp, this.file);
      })
      .catch((error) => console.error('[settings] save failed:', error));
    return this.writeChain;
  }

  get(key) { return this.data?.[key]; }

  async set(values) {
    Object.assign(this.data, values);
    await this.save();
    return this.data;
  }

  verifyPassword(password, fallback = 'change-me') {
    if (this.data?.sitePasswordHash) return hashPassword(password) === this.data.sitePasswordHash;
    return String(password || '') === String(fallback || 'change-me');
  }

  async setPassword(password) {
    const value = String(password || '');
    if (value.length < 6) throw new Error('访问密码至少需要 6 个字符');
    await this.set({ sitePasswordHash: hashPassword(value), passwordChanged: true });
  }

  publicSettings() {
    return {
      mediaRoot: this.data?.mediaRoot || '/QuarkTV',
      passwordChanged: Boolean(this.data?.passwordChanged || this.data?.sitePasswordHash),
    };
  }
}

module.exports = SettingsStore;