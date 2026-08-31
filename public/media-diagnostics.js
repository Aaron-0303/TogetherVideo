(() => {
  const video = document.getElementById('video');
  const notice = document.getElementById('playerNotice');
  const badge = document.getElementById('syncBadge');
  const player = window.TogetherMediaPlayer || video;
  if (!video || !player || !notice || !badge) return;

  video.setAttribute('playsinline', '');
  video.setAttribute('webkit-playsinline', '');
  video.preload = 'auto';

  let diagnosticSeq = 0;

  function currentMediaPath() {
    const raw = player.src || video.getAttribute('src') || '';
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
    return '播放器错误';
  }

  function appleHevcHint(media = {}) {
    if (!/\.mp4$|\.m4v$|\.mov$/i.test(media.extension || '')) return '';
    return '如果这是 HEVC/H.265 MP4，请先用 ffprobe 检查 codec_tag_string。Apple Safari 对 hvc1 更友好；若为 hev1，可无损重封装：ffmpeg -i "input.mp4" -map 0 -c copy -tag:v hvc1 -movflags +faststart "output.hvc1.mp4"。这不会重新编码，也不会降低画质。';
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
    const fallback = player.mode === 'libmedia';
    const lines = [fallback
      ? '非 Safari 兼容播放器也未能完成播放。'
      : `${mediaErrorName(mediaErrorCode)}。`];

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
      lines.push('没有检测到 Byte Range/206 支持；原生和兼容播放器都会受到影响。');
    }

    const attachment = probe.contentDisposition && /attachment/i.test(probe.contentDisposition);
    const wrongMime = probe.contentType && !/^video\//i.test(probe.contentType);

    if (fallback) {
      lines.push('3.0.1 已绕过原生 <video> 的解封装/解码路径，改由非 Safari libmedia 在浏览器内读取 123 Range、解析容器并选择 WebCodecs/硬件或 WASM 解码。');
      if (probe.rangeSupported) {
        lines.push('因此当前失败不再由 123 的 attachment/octet-stream 响应头直接造成；下一步应检查兼容核心错误、设备解码能力或 4K 媒体的性能/内存限制。');
      }
    } else if (bridge && (attachment || wrongMime)) {
      lines.push(`浏览器本地兼容层已经在交给 <video> 前把响应修正为 ${media.expectedMime || 'video/*'} + inline，并保留 206/Content-Range。`);
      if (probe.rangeSupported) lines.push('传输链路基本正常；若 Safari 原生播放仍失败，应优先检查 MP4 内部 Codec 与 HEVC sample entry，而不是继续修改 MIME。');
    } else {
      if (!window.MediaTransport?.supported?.()) {
        lines.push('当前页面无法使用 Service Worker 本地媒体兼容层；移动端请确认网站使用 HTTPS。');
      } else if (!bridge) {
        lines.push('Service Worker 本地媒体兼容层当前未接管页面；刷新页面后再试一次。');
      }
      if (attachment) lines.push('原始直链是 attachment 下载响应。');
      if (wrongMime) lines.push(`原始 MIME 不是 video/*（当前为 ${probe.contentType}）。`);
    }

    if (media.expectedMime) {
      const support = video.canPlayType(media.expectedMime);
      if (!support) lines.push(`原生浏览器报告不支持 ${media.expectedMime} 容器。`);
      else lines.push(`原生浏览器支持 ${media.expectedMime} 容器；这只代表容器可接受，不代表容器里的 HEVC/H.264 轨道一定可播放。`);
    }

    if (!media.mobilePreferred) lines.push('该封装不是移动端优先格式。');
    if (fallback) {
      lines.push(`兼容核心错误：${player.error?.message || '未提供具体错误信息'}。`);
    } else {
      const hint = appleHevcHint(media);
      if (hint) lines.push(hint);
    }
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
      badge.textContent = player.mode === 'libmedia' ? '兼容播放失败 · 已诊断' : '播放失败 · 已诊断';
      badge.classList.remove('good');
    } catch (error) {
      if (seq !== diagnosticSeq) return;
      notice.textContent = `${player.mode === 'libmedia' ? '兼容播放失败' : mediaErrorName(code)}。媒体诊断失败：${error.message}。`;
      notice.classList.add('error');
    }
  });
})();
