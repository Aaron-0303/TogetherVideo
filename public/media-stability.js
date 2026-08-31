(() => {
  const HybridMediaClass = window.HybridMedia;
  if (!HybridMediaClass || HybridMediaClass.__togetherStabilityPatched) return;
  HybridMediaClass.__togetherStabilityPatched = true;

  const METADATA_TIMEOUT_MS = 15000;
  const MAX_LOAD_RETRIES = 2;
  const RETRY_DELAYS_MS = [700, 1800];
  const REQUIRED_BUFFER_SECONDS = 3.0;
  const FALLBACK_BUFFER_SECONDS = 1.0;
  const DUPLICATE_SEEK_TOLERANCE = 0.25;

  const proto = HybridMediaClass.prototype;
  const originalLoad = proto.load;
  const originalGetBufferedAhead = proto.getBufferedAhead;
  const currentTimeDescriptor = Object.getOwnPropertyDescriptor(proto, 'currentTime');
  const readyStateDescriptor = Object.getOwnPropertyDescriptor(proto, 'readyState');

  function setPlayerStatus(title, notice = '') {
    const badge = document.getElementById('syncBadge');
    const message = document.getElementById('playerNotice');
    if (badge && title) {
      badge.textContent = title;
      badge.classList.remove('good');
    }
    if (message && notice) {
      message.textContent = notice;
      message.classList.remove('error');
    }
  }

  function clearTimer(player, key) {
    clearTimeout(player[key]);
    player[key] = null;
  }

  function clearLoadTimers(player) {
    clearTimer(player, '__togetherMetadataTimer');
    clearTimer(player, '__togetherRetryTimer');
  }

  function logicalMediaSource(source) {
    try {
      const url = new URL(source, location.href);
      if (url.pathname === '/api/media') {
        url.searchParams.delete('_fresh');
        url.searchParams.delete('_retry');
        url.searchParams.delete('_reload');
      }
      return url.toString();
    } catch {
      return String(source || '');
    }
  }

  function retryMediaSource(source, attempt) {
    try {
      const url = new URL(logicalMediaSource(source), location.href);
      if (url.pathname !== '/api/media') return url.toString();
      url.searchParams.set('_fresh', '1');
      url.searchParams.set('_retry', String(attempt));
      url.searchParams.set('_reload', String(Date.now()));
      return url.toString();
    } catch {
      return String(source || '');
    }
  }

  function finishWithLoadFailure(player) {
    clearLoadTimers(player);
    setPlayerStatus('媒体连接失败', '媒体连续多次加载超时。请检查 123 直链/网络后点击“重新同步”或刷新页面。');
    const message = document.getElementById('playerNotice');
    message?.classList.add('error');
    // app-3.1.js owns room state. Emit a media error only after bounded retries so
    // it can leave sourceLoading instead of remaining in a permanent black-screen state.
    try { player._emit?.('error'); } catch {}
  }

  function armMetadataWatchdog(player, token) {
    clearTimer(player, '__togetherMetadataTimer');
    player.__togetherMetadataTimer = setTimeout(() => {
      if (token !== player.__togetherStabilityToken) return;
      if (!player.src || player.readyState >= HTMLMediaElement.HAVE_METADATA) return;

      const attempt = Number(player.__togetherLoadRetry || 0);
      if (attempt >= MAX_LOAD_RETRIES) {
        finishWithLoadFailure(player);
        return;
      }

      const nextAttempt = attempt + 1;
      player.__togetherLoadRetry = nextAttempt;
      const delay = RETRY_DELAYS_MS[Math.min(nextAttempt - 1, RETRY_DELAYS_MS.length - 1)] || 0;
      setPlayerStatus(
        `媒体重新连接 ${nextAttempt}/${MAX_LOAD_RETRIES}`,
        '媒体元数据长时间没有返回，正在刷新 123 临时地址并重新建立 Range 连接…',
      );

      clearTimer(player, '__togetherRetryTimer');
      player.__togetherRetryTimer = setTimeout(() => {
        if (token !== player.__togetherStabilityToken) return;
        const original = player.__togetherLogicalSource || player.src;
        player.src = retryMediaSource(original, nextAttempt);
        originalLoad.call(player);
        armMetadataWatchdog(player, token);
      }, delay);
    }, METADATA_TIMEOUT_MS);
  }

  function bindPlayerRecovery(player) {
    if (player.__togetherRecoveryBound) return;
    player.__togetherRecoveryBound = true;

    player.addEventListener('loadedmetadata', () => {
      clearLoadTimers(player);
      player.__togetherLoadRetry = 0;
    });

    player.addEventListener('seeked', () => {
      player.__togetherSeekTarget = null;
    });
  }

  // Defer the first real media request until the Service Worker has either
  // claimed the page or explicitly fallen back to direct mode. This removes the
  // cold-start race that disproportionately affected the second viewer.
  proto.load = function stableLoad() {
    bindPlayerRecovery(this);
    const source = this.src;
    const token = Number(this.__togetherStabilityToken || 0) + 1;
    this.__togetherStabilityToken = token;
    clearLoadTimers(this);

    if (!source) {
      this.__togetherLogicalSource = '';
      this.__togetherLoadRetry = 0;
      return originalLoad.call(this);
    }

    this.__togetherLogicalSource = logicalMediaSource(source);
    this.__togetherLoadRetry = 0;
    setPlayerStatus('准备媒体通道', '正在确认浏览器媒体通道，然后再连接 123 视频数据…');

    const transportReady = window.MediaTransport?.ready?.() ?? Promise.resolve(false);
    Promise.resolve(transportReady)
      .catch(() => false)
      .finally(() => {
        if (token !== this.__togetherStabilityToken || !this.src) return;
        originalLoad.call(this);
        armMetadataWatchdog(this, token);
      });
  };

  // Repeated room:barrier packets must not restart an in-flight native seek to
  // the same target. A new target still supersedes the old one immediately.
  if (currentTimeDescriptor?.get && currentTimeDescriptor?.set) {
    Object.defineProperty(proto, 'currentTime', {
      configurable: true,
      enumerable: currentTimeDescriptor.enumerable,
      get: currentTimeDescriptor.get,
      set(value) {
        const target = Math.max(0, Number(value || 0));
        const previous = Number(this.__togetherSeekTarget);
        if (
          this.mode === 'native'
          && this.video?.seeking
          && Number.isFinite(previous)
          && Math.abs(previous - target) <= DUPLICATE_SEEK_TOLERANCE
        ) return;
        this.__togetherSeekTarget = target;
        currentTimeDescriptor.set.call(this, target);
      },
    });
  }

  // For native playback, the barrier should not call a viewer ready merely
  // because HAVE_FUTURE_DATA flickered true. Require about 3 seconds of actual
  // buffered range; after the app's existing 10s fallback, at least 1 second is
  // still required. libmedia keeps its own readiness semantics.
  proto.getBufferedAhead = function stableBufferedAhead() {
    const raw = Number(originalGetBufferedAhead.call(this));
    if (this.mode !== 'native' || !Number.isFinite(raw)) return raw;
    return raw >= REQUIRED_BUFFER_SECONDS ? raw : 0;
  };

  if (readyStateDescriptor?.get) {
    Object.defineProperty(proto, 'readyState', {
      configurable: true,
      enumerable: readyStateDescriptor.enumerable,
      get() {
        const value = Number(readyStateDescriptor.get.call(this));
        if (this.mode !== 'native') return value;
        const rawAhead = Number(originalGetBufferedAhead.call(this));
        if (!Number.isFinite(rawAhead) || rawAhead >= REQUIRED_BUFFER_SECONDS) return value;
        if (rawAhead >= FALLBACK_BUFFER_SECONDS) {
          return Math.min(value, HTMLMediaElement.HAVE_CURRENT_DATA);
        }
        return Math.min(value, HTMLMediaElement.HAVE_METADATA);
      },
    });
  }
})();
