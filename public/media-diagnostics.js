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
    const raw = player.src || video.getAttribute('src') || '';
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

  async function inspectServer(path) {
    const response = await fetch(`/api/media/check?path=${encodeURIComponent(path)}`, {
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false) throw new Error(data.error || `HTTP ${response.status}`);
    return data;
  }

  async function inspectBrowserBridge(path) {
    if (window.MediaTransport?.mode?.() !== 'service-worker') {
      return { active: false, error: 'Service Worker 未接管当前页面' };
    }
    try {
      const response = await fetch(`/api/media?path=${encodeURIComponent(path)}&_diag=${Date.now()}`, {
        method: 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { Range: 'bytes=0-0' },
      });
      const result = {
        active: true,
        status: response.status,
        contentType: response.headers.get('content-type') || '',
        contentRange: response.headers.get('content-range') || '',
        contentLength: response.headers.get('content-length') || '',
        mode: response.headers.get('x-togethervideo-media-mode') || '',
        version: response.headers.get('x-togethervideo-media-version') || '',
      };
      await response.body?.cancel().catch(() => {});
      return result;
    } catch (error) {
      return { active: true, status: 0, error: error.message || String(error) };
    }
  }

  function describe(serverResult, bridge, mediaErrorCode) {
    const media = serverResult?.media || {};
    const probe = serverResult?.probe || {};
    const lines = [`${mediaErrorName(mediaErrorCode)}。3.2.5 使用 ArtPlayer 控件，但真正解码仍由它内部的原生 HTMLVideoElement 完成；123 数据通过稳定的浏览器本地 Range/MIME bridge 读取。`];

    const serverBits = [];
    if (probe.headStatus) serverBits.push(`HEAD ${probe.headStatus}`);
    if (probe.rangeStatus) serverBits.push(`Range GET ${probe.rangeStatus}`);
    if (probe.contentRange) serverBits.push(`Content-Range ${probe.contentRange}`);
    if (probe.contentType) serverBits.push(`原始 MIME ${probe.contentType}`);
    if (probe.finalHost) serverBits.push(`节点 ${probe.finalHost}`);
    lines.push(`123 服务端实测：${serverBits.join(' · ') || '无有效结果'}。`);

    if (probe.rangeVerified) {
      lines.push('已真实验证 CDN 返回 HTTP 206 + Content-Range，不再用 HEAD 200 推断 Range 能力。');
    } else {
      lines.push('关键异常：没有真实拿到 206 + Content-Range。123 即使声明 Accept-Ranges，也不能视为实际 Range 可用。');
    }

    if (!bridge.active) {
      lines.push(`浏览器媒体桥未生效：${bridge.error || '未知原因'}。请确认 HTTPS 并强制刷新页面。`);
    } else if (bridge.status) {
      const version = bridge.version ? ` · bridge ${bridge.version}` : '';
      lines.push(`浏览器桥接实测：HTTP ${bridge.status}${bridge.contentRange ? ` · ${bridge.contentRange}` : ''}${bridge.contentType ? ` · ${bridge.contentType}` : ''}${version}。`);
      if (bridge.status !== 206 || !/^bytes\s/i.test(bridge.contentRange || '')) {
        lines.push('浏览器实际播放链路没有得到标准 206 Range；此时不要先怀疑视频编码。');
      } else if (!/^video\//i.test(bridge.contentType || '')) {
        lines.push('Range 正常，但桥接后的 MIME 仍不是 video/*，属于媒体桥响应头问题。');
      } else {
        lines.push('ArtPlayer 内部 video 实际链路已经得到标准 206 和 video/*；若仍失败，才继续检查 MP4 内部封装与 Codec。');
      }
    } else {
      lines.push(`浏览器桥接自测失败：${bridge.error || '未知错误'}。`);
    }

    if (media.expectedMime) {
      const support = video.canPlayType(media.expectedMime);
      lines.push(support ? `浏览器声明可接受 ${media.expectedMime} 容器。` : `浏览器声明不接受 ${media.expectedMime} 容器。`);
    }

    if (/\.mp4$|\.m4v$|\.mov$/i.test(media.extension || '')) {
      lines.push('只有在浏览器桥接自测为 206 + video/mp4 后仍失败，才需要继续检查 H.264/HEVC/AAC、moov atom 和 HEVC hvc1/hev1。');
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
      const [serverResult, bridge] = await Promise.all([inspectServer(path), inspectBrowserBridge(path)]);
      if (seq !== diagnosticSeq) return;
      notice.textContent = describe(serverResult, bridge, code);
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
