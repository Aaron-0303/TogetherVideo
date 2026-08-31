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
    return '如果 MIME 已经修正但 Safari 仍无法播放 HEVC/H.265 MP4，再用 ffprobe 检查 codec_tag_string；Apple Safari 对 hvc1 更友好。';
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
    const lines = [`${mediaErrorName(mediaErrorCode)}。当前使用 Artplayer 控件 + 原生 HTMLVideoElement；浏览器本地 MIME bridge 会修正 123 的下载型响应，并恢复 3.1.2 的 16 MiB 有界 Range 读取，避免首包退化成整个大文件的 HTTP 200。`];

    if (!probe.ok) {
      lines.push(`123 媒体节点探测失败${probe.status ? `（HTTP ${probe.status}）` : ''}。`);
      if (probe.error === 'timeout') lines.push('下载节点响应超时。');
      return lines.join(' ');
    }

    const details = [];
    if (probe.status) details.push(`HTTP ${probe.status}`);
    if (probe.contentType) details.push(`原始 Content-Type ${probe.contentType}`);
    if (probe.finalHost) details.push(`节点 ${probe.finalHost}`);
    if (probe.contentLength) details.push(`大小 ${(probe.contentLength / 1024 / 1024 / 1024).toFixed(2)} GB`);
    lines.push(`123 原始响应：${details.join(' · ') || '可访问'}。`);

    if (!probe.rangeSupported) {
      lines.push('没有检测到 Byte Range 支持，这会直接影响拖动和连续播放。');
    } else {
      lines.push('服务端支持 Byte Range；浏览器媒体请求会按 16 MiB 窗口读取，保留请求起点并避免一次请求整个剩余文件。');
    }

    if (/application\/octet-stream/i.test(probe.contentType || '')) {
      lines.push(`原始 octet-stream 会在浏览器本地改写为 ${media.expectedMime || 'video/*'}，同时移除 attachment/nosniff 对原生播放器的影响。`);
    }

    if (media.expectedMime) {
      const support = video.canPlayType(media.expectedMime);
      if (!support) lines.push(`浏览器报告不支持 ${media.expectedMime} 容器。`);
      else lines.push(`浏览器接受 ${media.expectedMime} 容器；如果有界 Range 和 MIME bridge 均已工作但仍失败，再检查内部 H.264/HEVC/AAC 轨道。`);
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
