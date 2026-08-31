(() => {
  const ArtplayerClass = window.Artplayer;
  if (!ArtplayerClass) throw new Error('Artplayer runtime is not loaded');

  function safeDispatch(target, type, detail) {
    try {
      target.dispatchEvent(detail === undefined ? new Event(type) : new CustomEvent(type, { detail }));
    } catch {}
  }

  function logicalMediaPath(source) {
    try {
      const url = new URL(source, location.href);
      if (url.origin !== location.origin || url.pathname !== '/api/media') return '';
      return url.searchParams.get('path') || '';
    } catch {
      return '';
    }
  }

  class ArtplayerMedia {
    constructor(options = {}) {
      this.events = new EventTarget();
      this.mode = 'native';
      this.source = '';
      this.resolvedSource = '';
      this.loadToken = 0;
      this._loadError = null;
      this._hasRenderedFrame = false;

      const legacyVideo = options.video || null;
      const container = options.container;
      if (!container) throw new Error('Artplayer container is required');

      if (legacyVideo) {
        try { legacyVideo.pause(); } catch {}
        try { legacyVideo.removeAttribute('src'); } catch {}
        legacyVideo.removeAttribute('id');
        legacyVideo.classList.add('hidden');
      }

      container.classList.remove('hidden');
      container.replaceChildren();
      container.style.position = 'absolute';
      container.style.inset = '0';
      container.style.width = '100%';
      container.style.height = '100%';

      this.art = new ArtplayerClass({
        container,
        url: '',
        autoplay: false,
        autoSize: false,
        autoMini: false,
        loop: false,
        mutex: false,
        volume: 1,
        setting: true,
        playbackRate: true,
        aspectRatio: true,
        fullscreen: true,
        fullscreenWeb: true,
        pip: true,
        hotkey: true,
        miniProgressBar: true,
        playsInline: true,
        lock: true,
        fastForward: true,
        theme: '#ff5f78',
      });

      this.video = this.art.video;
      this.video.id = 'video';
      this.video.preload = 'metadata';
      this.video.setAttribute('playsinline', '');
      this.video.setAttribute('webkit-playsinline', '');
      try {
        if ('preservesPitch' in this.video) this.video.preservesPitch = true;
        if ('webkitPreservesPitch' in this.video) this.video.webkitPreservesPitch = true;
      } catch {}

      this._bindNativeEvents();
      this._retireLegacyServiceWorkers();
    }

    _bindNativeEvents() {
      const passthrough = [
        'play', 'pause', 'playing', 'waiting', 'stalled', 'canplay', 'loadeddata',
        'loadedmetadata', 'progress', 'seeking', 'seeked', 'ratechange', 'ended',
        'timeupdate', 'volumechange', 'durationchange', 'emptied', 'abort',
      ];

      for (const type of passthrough) {
        this.video.addEventListener(type, () => {
          if (type === 'loadeddata' || type === 'playing') this._hasRenderedFrame = true;
          safeDispatch(this.events, type);
        });
      }

      this.video.addEventListener('error', () => {
        if (!this.source) return;
        safeDispatch(this.events, 'error');
      });
    }

    _retireLegacyServiceWorkers() {
      if (!('serviceWorker' in navigator)) return;
      navigator.serviceWorker.getRegistrations()
        .then((registrations) => Promise.allSettled(registrations.map((registration) => registration.unregister())))
        .catch(() => {});
    }

    async _resolveDirectSource(source, token) {
      const mediaPath = logicalMediaPath(source);
      if (!mediaPath) return new URL(source, location.href).toString();

      const response = await fetch(`/api/media/url?path=${encodeURIComponent(mediaPath)}`, {
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { Accept: 'application/json' },
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok === false || !data.url) {
        throw new Error(data.error || `媒体地址解析失败 (${response.status})`);
      }
      if (token !== this.loadToken) throw new DOMException('stale media load', 'AbortError');
      return data.url;
    }

    load() {
      const token = ++this.loadToken;
      this._loadError = null;
      this._hasRenderedFrame = false;
      const source = this.source;

      if (!source) {
        this.resolvedSource = '';
        this.video.removeAttribute('src');
        try { this.video.load(); } catch {}
        return;
      }

      // The logical URL stays same-origin for room state/diagnostics, but the
      // actual HTMLVideoElement receives the final CDN URL. No Service Worker,
      // fetch-stream wrapper or manual Range slicing sits in the media path.
      this._resolveDirectSource(source, token)
        .then((resolved) => {
          if (token !== this.loadToken) return;
          this.resolvedSource = resolved;
          this.video.src = resolved;
          this.video.preload = 'metadata';
          this.video.load();
          safeDispatch(this.events, 'sourcechange', { source, resolved });
        })
        .catch((error) => {
          if (token !== this.loadToken || error?.name === 'AbortError') return;
          this._loadError = { code: 2, message: error?.message || String(error) };
          safeDispatch(this.events, 'error');
        });
    }

    play() { return this.video.play(); }
    pause() { this.video.pause(); }

    addEventListener(type, handler, options) { this.events.addEventListener(type, handler, options); }
    removeEventListener(type, handler, options) { this.events.removeEventListener(type, handler, options); }

    removeAttribute(name) {
      if (String(name).toLowerCase() === 'src') {
        this.source = '';
        this.resolvedSource = '';
        this.loadToken += 1;
        this.video.removeAttribute('src');
        return;
      }
      this.video.removeAttribute(name);
    }

    get src() { return this.source; }
    set src(value) { this.source = String(value || ''); }

    get currentSrc() { return this.video.currentSrc || this.resolvedSource || ''; }
    get paused() { return this.video.paused; }
    get seeking() { return this.video.seeking; }
    get ended() { return this.video.ended; }
    get duration() { return this.video.duration; }
    get readyState() { return this.video.readyState; }
    get networkState() { return this.video.networkState; }
    get error() { return this._loadError || this.video.error; }
    get buffered() { return this.video.buffered; }
    get hasRenderedFrame() { return this._hasRenderedFrame; }

    get currentTime() { return Number(this.video.currentTime || 0); }
    set currentTime(value) {
      const next = Math.max(0, Number(value || 0));
      if (!Number.isFinite(next)) return;
      this.video.currentTime = next;
    }

    get playbackRate() { return Number(this.video.playbackRate || 1); }
    set playbackRate(value) {
      const next = Number(value || 1);
      if (Number.isFinite(next) && next > 0) this.video.playbackRate = next;
    }

    get volume() { return Number(this.video.volume || 0); }
    set volume(value) {
      const next = Math.max(0, Math.min(1, Number(value || 0)));
      if (Number.isFinite(next)) this.video.volume = next;
    }

    get muted() { return Boolean(this.video.muted); }
    set muted(value) { this.video.muted = Boolean(value); }

    getBufferedAhead() {
      const current = Number(this.video.currentTime || 0);
      const ranges = this.video.buffered;
      for (let i = 0; i < ranges.length; i += 1) {
        const start = ranges.start(i);
        const end = ranges.end(i);
        if (current >= start - 0.2 && current <= end + 0.2) return Math.max(0, end - current);
      }
      return 0;
    }

    destroy() {
      this.loadToken += 1;
      try { this.art.destroy(false); } catch {}
    }
  }

  window.ArtplayerMedia = ArtplayerMedia;
  // Keep the 3.1 room client API stable while the 3.2 player implementation is
  // swapped underneath it. This alias can disappear when app-3.1.js is renamed.
  window.HybridMedia = ArtplayerMedia;
})();
