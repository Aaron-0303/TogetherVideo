(() => {
  const video = document.getElementById('video');
  const notice = document.getElementById('playerNotice');
  const badge = document.getElementById('syncBadge');
  if (!video || !notice || !badge) return;

  // Modern Safari uses playsinline, while the prefixed form still helps older
  // WebKit-based clients. `auto` is only a hint; mobile browsers may ignore it.
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
    const lines = [`${mediaErrorName(mediaErrorCode)}。`];

    if (!probe.ok) {
      lines.push(`123 直链探测失败${probe.status ? `（HTTP ${probe.status}）` : ''}。`);
      if (probe.error === 'timeout') lines.push('下载节点响应超时。');
      lines.push('这更像是直链/节点访问问题，而不是视频编码问题。');
      return lines.join(' ');
    }

    const details = [];
    if (probe.status) details.push(`HTTP ${probe.status}`);
    if (probe.contentType) details.push(`Content-Type ${probe.contentType}`);
    if (probe.finalHost) details.push(`节点 ${probe.finalHost}`);
    lines.push(`123 直链可访问：${details.join(' · ') || '响应正常'}。`);

    if (!probe.rangeSupported) {
      lines.push('没有检测到 Byte Range/206 支持；iPad/iPhone Safari 对视频随机访问和拖动进度条非常依赖 Range，这可能直接导致无法播放。');
    }

    if (probe.contentDisposition && /attachment/i.test(probe.contentDisposition)) {
      lines.push('直链返回了 attachment 下载响应；桌面浏览器可能仍能播放，但移动 Safari 可能更严格。');
    }

    if (probe.contentType && !/^video\//i.test(probe.contentType)) {
      lines.push(`直链 MIME 不是 video/*（当前为 ${probe.contentType}），移动 Safari 可能拒绝把它当视频加载。`);
    }

    if (media.expectedMime) {
      const support = video.canPlayType(media.expectedMime);
      if (!support) {
        lines.push(`当前浏览器报告不支持 ${media.expectedMime} 这种容器类型。`);
      } else if (probe.rangeSupported && /^video\//i.test(probe.contentType || '')) {
        lines.push('网络、Range 和容器 MIME 基本正常，因此更可能是文件内部的视频/音频编码不兼容。');
      }
    }

    if (!media.mobilePreferred) {
      lines.push('该封装不是移动端优先格式。');
    }
    lines.push('跨 iPad Safari、iPhone 和 Android Chrome 最稳妥的是 MP4 + H.264/AVC + AAC-LC。');
    return lines.join(' ');
  }

  video.addEventListener('loadedmetadata', () => { diagnosticSeq += 1; });

  video.addEventListener('error', async () => {
    const path = currentMediaPath();
    if (!path) return;
    const seq = ++diagnosticSeq;
    const code = video.error?.code || 0;

    // Let app.js display its immediate generic message first, then replace it
    // with evidence from the final provider response when the probe completes.
    try {
      const result = await inspect(path);
      if (seq !== diagnosticSeq) return;
      notice.textContent = describe(result, code);
      notice.classList.add('error');
      badge.textContent = '播放失败 · 已诊断';
      badge.classList.remove('good');
    } catch (error) {
      if (seq !== diagnosticSeq) return;
      notice.textContent = `${mediaErrorName(code)}。媒体诊断失败：${error.message}。建议优先测试 MP4（H.264/AVC + AAC-LC）。`;
      notice.classList.add('error');
    }
  });
})();
