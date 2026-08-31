(() => {
  const video = document.getElementById('video');
  const notice = document.getElementById('playerNotice');
  const badge = document.getElementById('syncBadge');
  if (!video || !notice || !badge) return;

  video.setAttribute('playsinline', '');
  video.setAttribute('webkit-playsinline', '');
  video.preload = 'auto';

  let diagnosticSeq = 0;

  function currentMediaPath() {
    const raw = video.getAttribute('src') || '';
    try {
      const url = new URL(raw, location.href);
      if (url.pathname !== '/api/media') return '';
      return url.searchParams.get('path') || '';
    } catch {
      return '';
    }
  }

  function localBridgeActive() {
    return window.MediaTransport?.mode?.() === 'service-worker';
  }

  function mediaErrorName(code) {
    if (code === MediaError.MEDIA_ERR_ABORTED) return '播放被中止';
    if (code === MediaError.MEDIA_ERR_NETWORK) return '网络读取失败';
    if (code === MediaError.MEDIA_ERR_DECODE) return '浏览器解码失败';
    if (code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED) return '媒体源不受支持';
    return '未知媒体错误';
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
    const bridge = localBridgeActive();
    const lines = [`${mediaErrorName(mediaErrorCode)}。`];

    if (!window.MediaTransport?.supported?.()) {
      lines.push('当前页面无法使用 Service Worker 本地媒体兼容层；移动端请确认网站使用 HTTPS。');
    } else if (!bridge) {
      lines.push('Service Worker 本地媒体兼容层当前未接管页面；刷新页面后再试一次。');
    }

    if (!probe.ok) {
      lines.push(`123 媒体节点探测失败${probe.status ? `（HTTP ${probe.status}）` : ''}。`);
      if (probe.error === 'timeout') lines.push('下载节点响应超时。');
      return lines.join(' ');
    }

    const details = [];
    if (probe.status) details.push(`HTTP ${probe.status}`);
    if (probe.contentType) details.push(`原始 Content-Type ${probe.contentType}`);
    if (probe.finalHost) details.push(`节点 ${probe.finalHost}`);
    lines.push(`123 原始响应：${details.join(' · ') || '可访问'}。`);

    if (!probe.rangeSupported) {
      lines.push('没有检测到 Byte Range/206 支持，移动 Safari 很可能无法稳定播放和拖动。');
    }

    const attachment = probe.contentDisposition && /attachment/i.test(probe.contentDisposition);
    const wrongMime = probe.contentType && !/^video\//i.test(probe.contentType);

    if (bridge && (attachment || wrongMime)) {
      lines.push(`浏览器本地兼容层已经在交给 <video> 前把响应修正为 ${media.expectedMime || 'video/*'} + inline，并保留 206/Content-Range。`);
      if (probe.rangeSupported) {
        lines.push('如果仍然播放失败，优先怀疑文件内部视频/音频编码，而不是 123 的 attachment/octet-stream 响应头。');
      }
    } else {
      if (attachment) lines.push('原始直链是 attachment 下载响应，移动 Safari 可能拒绝直接作为视频加载。');
      if (wrongMime) lines.push(`原始 MIME 不是 video/*（当前为 ${probe.contentType}）。`);
    }

    if (media.expectedMime) {
      const support = video.canPlayType(media.expectedMime);
      if (!support) lines.push(`当前浏览器报告不支持 ${media.expectedMime} 这种容器类型。`);
      else if (bridge && probe.rangeSupported) lines.push(`当前浏览器支持容器 ${media.expectedMime}；下一层需要检查实际 Codec。`);
    }

    if (!media.mobilePreferred) lines.push('该封装不是移动端优先格式。');
    lines.push('跨 iPad Safari、iPhone 和 Android Chrome 最稳妥的是 MP4 + H.264/AVC + AAC-LC。');
    return lines.join(' ');
  }

  video.addEventListener('loadedmetadata', () => { diagnosticSeq += 1; });

  video.addEventListener('error', async () => {
    const path = currentMediaPath();
    if (!path) return;
    const seq = ++diagnosticSeq;
    const code = video.error?.code || 0;

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
