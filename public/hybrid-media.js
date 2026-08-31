(() => {
  const AVPLAYER_MODULE_URL = '/vendor/libmedia/avplayer/avplayer.js';
  const WASM_BASE_URL = 'https://cdn.jsdelivr.net/gh/zhaohappy/libmedia@1.3.1/dist';

  function mediaExtension(source) {
    try {
      const url = new URL(source, location.href);
      const mediaPath = url.searchParams.get('path') || url.pathname;
      const match = String(mediaPath).toLowerCase().match(/\.([a-z0-9]+)$/);
      return match?.[1] || 'mp4';
    } catch {
      return 'mp4';
    }
  }

  function fallbackSource(source) {
    const url = new URL(source, location.href);
    if (url.origin === location.origin && url.pathname === '/api/media') {
      // The Service Worker owns /api/media for native <video>. AVPlayer must see
      // the original 307 so its FetchIOLoader can follow the provider URL itself.
      url.searchParams.set('_swresolve', '1');
    }
    return url.toString();
  }

  function formatTime(seconds) {
    const value = Math.max(0, Number(seconds || 0));
    if (!Number.isFinite(value)) return '00:00';
    const total = Math.floor(value);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return h
      ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
      : `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  class HybridMedia {
    constructor(options = {}) {
      this.video = options.video;
      this.container = options.container;
      this.controls = options.controls || null;
      this.shell = options.shell || this.video?.parentElement || null;
      this.events = new EventTarget();
      this.mode = 'native';
      this.source = '';
      this.avPlayer = null;
      this.avModule = null;
      this.avLoaded = false;
      this.avCurrentTime = 0;
      this.avDuration = NaN;
      this.avPaused = true;
      this.avSeeking = false;
      this.avEnded = false;
      this.avRate = 1;
      this.avVolume = 1;
      this.avError = null;
      this.switching = false;
      this.suppressNative = false;
      this.loadToken = 0;
      this._bindNative();
      this._bindControls();
      this._showMode('native');
    }

    _emit(type, detail) {
      this.events.dispatchEvent(detail === undefined
        ? new Event(type)
        : new CustomEvent(type, { detail }));
    }

    _bindNative() {
      if (!this.video) return;
      const passthrough = [
        'play', 'pause', 'playing', 'waiting', 'stalled', 'canplay', 'loadeddata',
        'loadedmetadata', 'progress', 'seeking', 'seeked', 'ratechange', 'ended',
        'timeupdate', 'volumechange',
      ];
      for (const type of passthrough) {
        this.video.addEventListener(type, () => {
          if (this.mode !== 'native' || this.suppressNative) return;
          this._updateControls();
          this._emit(type);
        });
      }

      this.video.addEventListener('error', () => {
        if (this.mode !== 'native' || this.suppressNative || !this.source) return;
        const nativeError = this.video.error;
        this._startFallback(nativeError).catch((error) => {
          this.avError = { code: nativeError?.code || 4, message: error?.message || String(error) };
          this._emit('fallbackfailed', { error });
          this._emit('error');
        });
      });
    }

    _bindControls() {
      const controls = this.controls;
      if (!controls) return;

      controls.play?.addEventListener('click', () => {
        if (this.paused) this.play().catch(() => {});
        else this.pause();
      });

      controls.seek?.addEventListener('input', () => {
        if (!Number.isFinite(this.duration) || this.duration <= 0) return;
        const preview = Number(controls.seek.value || 0) / 1000 * this.duration;
        if (controls.time) controls.time.textContent = `${formatTime(preview)} / ${formatTime(this.duration)}`;
      });
      controls.seek?.addEventListener('change', () => {
        if (!Number.isFinite(this.duration) || this.duration <= 0) return;
        this.currentTime = Number(controls.seek.value || 0) / 1000 * this.duration;
      });

      controls.volume?.addEventListener('input', () => {
        this.volume = Number(controls.volume.value || 0);
      });

      controls.fullscreen?.addEventListener('click', () => {
        if (document.fullscreenElement) document.exitFullscreen?.();
        else this.shell?.requestFullscreen?.();
      });
    }

    _showMode(mode) {
      this.mode = mode;
      if (this.video) this.video.classList.toggle('hidden', mode !== 'native');
      if (this.container) this.container.classList.toggle('hidden', mode !== 'libmedia');
      if (this.controls?.root) this.controls.root.classList.toggle('hidden', mode !== 'libmedia');
      this._updateControls();
      this._emit('enginechange', { mode });
    }

    _updateControls() {
      const controls = this.controls;
      if (!controls) return;
      if (controls.play) controls.play.textContent = this.paused ? '▶ 播放' : '❚❚ 暂停';
      if (controls.time) controls.time.textContent = `${formatTime(this.currentTime)} / ${formatTime(this.duration)}`;
      if (controls.seek && Number.isFinite(this.duration) && this.duration > 0) {
        if (document.activeElement !== controls.seek) {
          controls.seek.value = String(Math.max(0, Math.min(1000, this.currentTime / this.duration * 1000)));
        }
        controls.seek.disabled = false;
      } else if (controls.seek) {
        controls.seek.value = '0';
        controls.seek.disabled = true;
      }
      if (controls.volume && document.activeElement !== controls.volume) controls.volume.value = String(this.volume);
    }

    async _loadAVModule() {
      if (this.avModule) return this.avModule;
      const module = await import(AVPLAYER_MODULE_URL);
      if (!module?.default || !module?.Events) throw new Error('libmedia AVPlayer 模块格式不正确');
      this.avModule = module;
      return module;
    }

    async _destroyAVPlayer() {
      const player = this.avPlayer;
      this.avPlayer = null;
      this.avLoaded = false;
      if (!player) return;
      try { await player.pause(); } catch {}
      try { await player.destroy(); } catch {}
      if (this.container) this.container.replaceChildren();
    }

    _wireAVPlayer(player, Events, token) {
      const active = () => this.avPlayer === player && token === this.loadToken;
      player.on(Events.LOADING, () => { if (active()) this._emit('waiting'); });
      player.on(Events.LOADED, () => {
        if (!active()) return;
        this.avLoaded = true;
        this.avDuration = Number(player.getDuration?.() || 0n) / 1000;
        this.avEnded = false;
        this._updateControls();
        this._emit('loadedmetadata');
        this._emit('loadeddata');
        this._emit('canplay');
      });
      player.on(Events.PLAYING, () => {
        if (!active()) return;
        this.avPaused = false;
        this.avEnded = false;
        this._updateControls();
        this._emit('play');
        this._emit('playing');
      });
      player.on(Events.PAUSED, () => {
        if (!active()) return;
        this.avPaused = true;
        this._updateControls();
        this._emit('pause');
      });
      player.on(Events.SEEKING, () => {
        if (!active()) return;
        this.avSeeking = true;
        this._emit('seeking');
        this._emit('waiting');
      });
      player.on(Events.SEEKED, () => {
        if (!active()) return;
        this.avSeeking = false;
        this._emit('seeked');
        this._emit('canplay');
      });
      player.on(Events.TIME, (pts) => {
        if (!active()) return;
        this.avCurrentTime = Number(pts || 0) / 1000;
        this._updateControls();
        this._emit('timeupdate');
        this._emit('progress');
      });
      player.on(Events.PROGRESS, () => { if (active()) this._emit('progress'); });
      player.on(Events.TIMEOUT, () => {
        if (!active()) return;
        this._emit('waiting');
        this._emit('stalled');
      });
      player.on(Events.ENDED, () => {
        if (!active()) return;
        this.avPaused = true;
        this.avEnded = true;
        this.avCurrentTime = Number.isFinite(this.avDuration) ? this.avDuration : this.avCurrentTime;
        this._updateControls();
        this._emit('ended');
      });
      player.on(Events.ERROR, (error) => {
        if (!active()) return;
        this.avError = { code: 4, message: error?.message || String(error || 'libmedia error') };
        this._emit('error');
      });
    }

    async _startFallback(nativeError) {
      if (this.switching || this.mode === 'libmedia' || !this.source) return;
      this.switching = true;
      const token = ++this.loadToken;
      const source = this.source;
      const previousRate = Number(this.video?.playbackRate || this.avRate || 1);
      const previousVolume = Number(this.video?.volume ?? this.avVolume ?? 1);

      try {
        this._emit('fallbackstart', {
          nativeErrorCode: nativeError?.code || 0,
          reason: nativeError?.message || 'native-media-error',
        });

        this.suppressNative = true;
        try { this.video?.pause(); } catch {}
        this.video?.removeAttribute('src');
        this.video?.load();
        this.suppressNative = false;

        await this._destroyAVPlayer();
        const { default: AVPlayer, Events } = await this._loadAVModule();
        if (token !== this.loadToken) return;

        this._showMode('libmedia');
        this.avCurrentTime = 0;
        this.avDuration = NaN;
        this.avPaused = true;
        this.avSeeking = false;
        this.avEnded = false;
        this.avError = null;
        this.avRate = previousRate;
        this.avVolume = previousVolume;

        const player = new AVPlayer({
          container: this.container,
          wasmBaseUrl: WASM_BASE_URL,
          enableHardware: true,
          enableWebCodecs: true,
          enableWebGPU: true,
          enableWorker: true,
          enableAudioWorklet: true,
          preLoadTime: 30,
          loop: false,
        });
        this.avPlayer = player;
        this._wireAVPlayer(player, Events, token);

        await player.load(fallbackSource(source), {
          ext: mediaExtension(source),
          http: { credentials: 'same-origin' },
        });
        if (token !== this.loadToken || this.avPlayer !== player) return;

        this.avDuration = Number(player.getDuration?.() || 0n) / 1000;
        player.setVolume(this.avVolume);
        player.setPlaybackRate(Math.min(2, Math.max(0.5, this.avRate)));
        this._updateControls();
        this._emit('fallbackready', { mode: 'libmedia' });
      } finally {
        this.suppressNative = false;
        this.switching = false;
      }
    }

    get src() { return this.source; }
    set src(value) { this.source = String(value || ''); }

    removeAttribute(name) {
      if (name !== 'src') return;
      this.source = '';
      this.suppressNative = true;
      this.video?.removeAttribute('src');
      this.suppressNative = false;
    }

    load() {
      const source = this.source;
      if (!source) {
        ++this.loadToken;
        this._destroyAVPlayer().catch(() => {});
        this._showMode('native');
        this.suppressNative = true;
        this.video?.removeAttribute('src');
        this.video?.load();
        this.suppressNative = false;
        return;
      }

      ++this.loadToken;
      this._destroyAVPlayer().catch(() => {});
      this._showMode('native');
      this.avError = null;
      this.suppressNative = true;
      this.video.src = source;
      this.suppressNative = false;
      this.video.load();
    }

    async play() {
      if (this.mode === 'native') return this.video.play();
      if (!this.avPlayer) throw new Error('兼容播放器尚未就绪');
      if (this.avPlayer.isSuspended?.()) await this.avPlayer.resume().catch(() => {});
      return this.avPlayer.play({ subtitle: false });
    }

    pause() {
      if (this.mode === 'native') return this.video.pause();
      if (!this.avPlayer) return Promise.resolve();
      return this.avPlayer.pause();
    }

    get currentTime() {
      return this.mode === 'native' ? Number(this.video.currentTime || 0) : Number(this.avCurrentTime || 0);
    }
    set currentTime(value) {
      const target = Math.max(0, Number(value || 0));
      if (this.mode === 'native') {
        this.video.currentTime = target;
        return;
      }
      if (!this.avPlayer || !this.avLoaded) return;
      this.avCurrentTime = target;
      this.avPlayer.seek(BigInt(Math.floor(target * 1000))).catch((error) => {
        this.avError = { code: 4, message: error?.message || String(error) };
        this._emit('error');
      });
    }

    get duration() {
      return this.mode === 'native' ? Number(this.video.duration) : Number(this.avDuration);
    }
    get paused() { return this.mode === 'native' ? this.video.paused : this.avPaused; }
    get seeking() { return this.mode === 'native' ? this.video.seeking : this.avSeeking; }
    get ended() { return this.mode === 'native' ? this.video.ended : this.avEnded; }
    get readyState() { return this.mode === 'native' ? this.video.readyState : (this.avLoaded ? 4 : 0); }
    get error() { return this.mode === 'native' ? this.video.error : this.avError; }

    get playbackRate() {
      return this.mode === 'native' ? Number(this.video.playbackRate || 1) : Number(this.avRate || 1);
    }
    set playbackRate(value) {
      const rate = Math.min(2, Math.max(0.5, Number(value || 1)));
      if (this.mode === 'native') {
        this.video.playbackRate = rate;
        return;
      }
      this.avRate = rate;
      this.avPlayer?.setPlaybackRate(rate);
      this._emit('ratechange');
    }

    get volume() {
      return this.mode === 'native' ? Number(this.video.volume ?? 1) : Number(this.avVolume ?? 1);
    }
    set volume(value) {
      const volume = Math.min(1, Math.max(0, Number(value ?? 1)));
      if (this.mode === 'native') {
        this.video.volume = volume;
        return;
      }
      this.avVolume = volume;
      this.avPlayer?.setVolume(volume);
      this._updateControls();
      this._emit('volumechange');
    }

    addEventListener(...args) { return this.events.addEventListener(...args); }
    removeEventListener(...args) { return this.events.removeEventListener(...args); }
  }

  window.HybridMedia = HybridMedia;
})();
