const fs = require('fs/promises');
const path = require('path');

const USER_PLAYBACK_RATES = Object.freeze([0.5, 0.75, 1, 1.25, 1.5, 2]);

function cleanText(value, max = 200) {
  return String(value || '').trim().replace(/[<>]/g, '').slice(0, max);
}

function cleanMediaPath(value) {
  const raw = String(value || '').trim().replace(/\\/g, '/').replace(/^\/+/, '');
  if (!raw || raw.split('/').some((part) => part === '..')) return '';
  return path.posix.normalize(`/${raw}`).replace(/^\/+/, '');
}

function isUserPlaybackRate(value) {
  const rate = Number(value);
  return Number.isFinite(rate) && USER_PLAYBACK_RATES.some((allowed) => Math.abs(allowed - rate) < 1e-6);
}

function defaultState() {
  return {
    media: null,
    mediaVersion: 0,
    playing: false,
    position: 0,
    rate: 1,
    anchorAt: 0,
    revision: 0,
    updatedBy: '',
    reason: 'idle',
  };
}

function effectivePosition(state, now = Date.now()) {
  if (!state.playing || !state.anchorAt) return Math.max(0, Number(state.position || 0));
  const elapsed = Math.max(0, now - Number(state.anchorAt || now)) / 1000;
  return Math.max(0, Number(state.position || 0) + elapsed * Number(state.rate || 1));
}

class WatchRoom {
  constructor(file = '') {
    this.file = file;
    this.state = defaultState();
    this.writeChain = Promise.resolve();
  }

  async init() {
    if (!this.file) return;
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, 'utf8'));
      this.state = { ...defaultState(), ...(parsed || {}) };
      if (parsed?.media && parsed.media.path) this.state.media = { path: cleanMediaPath(parsed.media.path), name: cleanText(parsed.media.name) };
      // Older clients could accidentally publish an internal sync-correction rate
      // (for example 1.035x) as the room's authoritative user rate. Never restore
      // such a value after restart: only rates exposed by the UI are authoritative.
      if (!isUserPlaybackRate(this.state.rate)) this.state.rate = 1;
    } catch (error) {
      if (error.code !== 'ENOENT') console.warn('[room] resetting invalid watch state:', error.message);
    }
    if (this.state.playing) {
      const cappedNow = Math.min(Date.now(), Number(this.state.anchorAt || 0) + 30000);
      this.state.position = effectivePosition(this.state, cappedNow);
      this.state.playing = false;
      this.state.anchorAt = 0;
      this.state.reason = 'server-restart';
      this.state.revision++;
    }
    await this.save();
  }

  save() {
    if (!this.file) return Promise.resolve();
    const snapshot = JSON.stringify(this.state, null, 2);
    const tmp = `${this.file}.tmp`;
    this.writeChain = this.writeChain
      .then(async () => {
        await fs.writeFile(tmp, snapshot, 'utf8');
        await fs.rename(tmp, this.file);
      })
      .catch((error) => console.error('[room] save failed:', error));
    return this.writeChain;
  }

  snapshot(now = Date.now()) {
    return {
      media: this.state.media ? { ...this.state.media } : null,
      mediaVersion: Number(this.state.mediaVersion || 0),
      playing: Boolean(this.state.playing),
      position: effectivePosition(this.state, now),
      rate: Number(this.state.rate || 1),
      revision: Number(this.state.revision || 0),
      updatedBy: this.state.updatedBy || '',
      reason: this.state.reason || '',
    };
  }

  matchesMedia(payload = {}) {
    if (!this.state.media) return false;
    return Number(payload.mediaVersion) === Number(this.state.mediaVersion)
      && cleanMediaPath(payload.mediaPath) === this.state.media.path;
  }

  apply(action, payload = {}, actor = '') {
    const now = Date.now();
    const position = Number(payload.position);
    const who = cleanText(actor, 30);

    if (action === 'select') {
      const mediaPath = cleanMediaPath(payload.mediaPath);
      if (!mediaPath) return null;
      this.state.media = { path: mediaPath, name: cleanText(payload.mediaName) || path.posix.basename(mediaPath) };
      this.state.mediaVersion = Number(this.state.mediaVersion || 0) + 1;
      this.state.playing = false;
      this.state.position = 0;
      this.state.rate = 1;
      this.state.anchorAt = 0;
      this.state.reason = 'select';
    } else if (action === 'clear') {
      this.state.media = null;
      this.state.mediaVersion = Number(this.state.mediaVersion || 0) + 1;
      this.state.playing = false;
      this.state.position = 0;
      this.state.rate = 1;
      this.state.anchorAt = 0;
      this.state.reason = 'clear';
    } else if (action === 'wait') {
      if (!this.state.media) return null;
      this.state.position = effectivePosition(this.state, now);
      this.state.playing = false;
      this.state.anchorAt = 0;
      this.state.reason = 'wait';
    } else {
      if (!this.matchesMedia(payload)) return null;
      if (action === 'play') {
        this.state.position = Number.isFinite(position) ? Math.max(0, position) : effectivePosition(this.state, now);
        this.state.playing = true;
        this.state.anchorAt = now;
        this.state.reason = 'play';
      } else if (action === 'pause') {
        this.state.position = Number.isFinite(position) ? Math.max(0, position) : effectivePosition(this.state, now);
        this.state.playing = false;
        this.state.anchorAt = 0;
        this.state.reason = 'pause';
      } else if (action === 'seek') {
        if (!Number.isFinite(position)) return null;
        this.state.position = Math.max(0, position);
        if (this.state.playing) this.state.anchorAt = now;
        this.state.reason = 'seek';
      } else if (action === 'rate') {
        const rate = Number(payload.rate);
        // Internal sync correction rates are intentionally not valid room rates.
        // This prevents a delayed browser ratechange event from turning 1.01x or
        // 0.99x into the permanent authoritative playback speed for both viewers.
        if (!isUserPlaybackRate(rate)) return null;
        this.state.position = effectivePosition(this.state, now);
        this.state.rate = rate;
        if (this.state.playing) this.state.anchorAt = now;
        this.state.reason = 'rate';
      } else {
        return null;
      }
    }

    this.state.updatedBy = who;
    this.state.revision = Number(this.state.revision || 0) + 1;
    this.save();
    return this.snapshot(now);
  }
}

module.exports = { WatchRoom, effectivePosition, cleanMediaPath, isUserPlaybackRate, USER_PLAYBACK_RATES };