(() => {
  const player = window.TogetherMediaPlayer;
  const video = player?.video || document.getElementById('video');
  const notice = document.getElementById('playerNotice');
  const badge = document.getElementById('syncBadge');
  if (!video || !player || !notice || !badge) return;

  video.setAttribute('playsinline', '');
  video.setAttribute('webkit-playsinline', '');
  video.preload = 'metadata';

  let diagnosticSeq = 0;

  function currentMediaPath() {
    const raw = player.src || '';
    try {
      const url = new URL(raw, location.href);
      if (url.pathname !== '/api/media') return '';
      return url.searchParams.get('path') || '';
    } catch {
      return '';
    }
  }

  function mediaErrorName(code) {
    if (code === MediaError.MEDIA_ERR_ABORTED) return '播放被中止';
    if (code === MediaError.MEDIA_ERR_NETWORK) return '网络读取失败';
    if (code === MediaError.MEDIA_ERR_DECODE) return '浏览器解码失败';
    if (code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED) return '媒体源不受支持';
    return '播放器错误';
  }

  function appleHevcHint(media = {}) {
    if (!/\.mp4$|\.m4v$|\.mov$/i.test(media.extension || '')) return '';
    return '如果这是 HEVC/H.265 MP4，请用 ffprobe 检查 codec_tag_string。Apple Safari 对 hvc1 更友好；若为 hev1，可无损重封装为 hvc1，不需要重新编码。';
  }

  async function inspect(path) {
    const response = await fetch(`/api/media/check?path=${encodeURIComponent(path)}`, {
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false) throw new Error(data.error || `HTTP ${response.status}`);
    return data;
  }

  function describe(result, mediaErrorCode) {
    const media = result?.media || {};
    const probe = result?.probe || {};
    const lines = [`${mediaErrorName(mediaErrorCode)}。3.2 使用 Artplayer 控件，但底层仍是浏览器原生 HTMLVideoElement，并直接连接 123 CDN。`];

    if (!probe.ok) {
      lines.push(`123 媒体节点探测失败${probe.status ? `（HTTP ${probe.status}）` : ''}。`);
      if (probe.error === 'timeout') lines.push('下载节点响应超时。');
      return lines.join(' ');
    }

    const details = [];
    if (probe.status) details.push(`HTTP ${probe.status}`);
    if (probe.contentType) details.push(`Content-Type ${probe.contentType}`);
    if (probe.finalHost) details.push(`节点 ${probe.finalHost}`);
    if (probe.contentLength) details.push(`大小 ${(probe.contentLength / 1024 / 1024 / 1024).toFixed(2)} GB`);
    lines.push(`123 原始响应：${details.join(' · ') || '可访问'}。`);

    if (!probe.rangeSupported) {
      lines.push('没有检测到 Byte Range/206 支持，这会直接影响拖动和连续播放。');
    } else {
      lines.push('Range/206 可用；Range、连接复用、预读和 seek 现在完全交给 Safari/Chrome 原生媒体栈处理。');
    }

    if (media.expectedMime) {
      const support = video.canPlayType(media.expectedMime);
      if (!support) lines.push(`浏览器报告不支持 ${media.expectedMime} 容器。`);
      else lines.push(`浏览器接受 ${media.expectedMime} 容器，但最终是否可播仍取决于内部 H.264/HEVC 音视频轨道。`);
    }

    if (!media.mobilePreferred) lines.push('该封装不是移动端优先格式。');
    const hint = appleHevcHint(media);
    if (hint) lines.push(hint);
    return lines.join(' ');
  }

  player.addEventListener('loadedmetadata', () => { diagnosticSeq += 1; });

  player.addEventListener('error', async () => {
    const path = currentMediaPath();
    if (!path) return;
    const seq = ++diagnosticSeq;
    const code = player.error?.code || 0;

    try {
      const result = await inspect(path);
      if (seq !== diagnosticSeq) return;
      notice.textContent = describe(result, code);
      notice.classList.add('error');
      badge.textContent = '播放失败 · 已诊断';
      badge.classList.remove('good');
    } catch (error) {
      if (seq !== diagnosticSeq) return;
      notice.textContent = `${mediaErrorName(code)}。媒体诊断失败：${error.message}。`;
      notice.classList.add('error');
    }
  });
})();
