const $ = (id) => document.getElementById(id);

const ui = {
  loginLayer: $('loginLayer'), loginForm: $('loginForm'), nicknameInput: $('nicknameInput'), passwordInput: $('passwordInput'), loginError: $('loginError'),
  app: $('app'), socketBadge: $('socketBadge'), onlineBadge: $('onlineBadge'), logoutBtn: $('logoutBtn'), settingsBtn: $('settingsBtn'),
  libraryToggle: $('libraryToggle'), closeLibraryBtn: $('closeLibraryBtn'), libraryPanel: $('libraryPanel'), breadcrumbs: $('breadcrumbs'), libraryStatus: $('libraryStatus'), libraryList: $('libraryList'), refreshLibraryBtn: $('refreshLibraryBtn'),
  video: $('video'), emptyPlayer: $('emptyPlayer'), resumeOverlay: $('resumeOverlay'), mediaTitle: $('mediaTitle'), syncBadge: $('syncBadge'), playerNotice: $('playerNotice'),
  waitBtn: $('waitBtn'), syncNowBtn: $('syncNowBtn'), rateSelect: $('rateSelect'), selfStatus: $('selfStatus'), selfBuffering: $('selfBuffering'), peerStatus: $('peerStatus'), peerBuffering: $('peerBuffering'), peerDot: $('peerDot'),
  settingsModal: $('settingsModal'), closeSettingsBtn: $('closeSettingsBtn'), webdavUrl: $('webdavUrl'), webdavUsername: $('webdavUsername'), webdavPassword: $('webdavPassword'), webdavRoot: $('webdavRoot'), testWebdavBtn: $('testWebdavBtn'), saveWebdavBtn: $('saveWebdavBtn'), newSitePassword: $('newSitePassword'), saveSitePasswordBtn: $('saveSitePasswordBtn'), settingsNotice: $('settingsNotice'), toast: $('toast'),
};

const state = {
  nickname: '', participantId: '', socket: null, settings: null,
  libraryPath: '', librarySeq: 0,
  mediaPath: '', mediaVersion: 0, sourceLoading: false, mediaReady: false, loadSeq: 0,
  lastSnapshot: null, halfRttMs: 0, buffering: false, bufferTimer: null,
  expectedPlayUntil: 0, expectedPauseUntil: 0, expectedSeek: null, expectedRate: null,
  correctionTimer: null, correctionToken: 0, lastHardSeekAt: 0, syncTimer: null, lastPeerName: '',
};

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401 && url !== '/api/login') {
    showLogin();
    throw new Error(data.error || '登录已失效');
  }
  if (!response.ok || data.ok === false) throw new Error(data.error || `请求失败 (${response.status})`);
  return data;
}

function showLogin() {
  state.socket?.disconnect();
  clearInterval(state.syncTimer);
  ui.loginLayer.classList.remove('hidden');
  ui.app.classList.add('hidden');
  ui.settingsModal.classList.add('hidden');
}

function showApp() {
  ui.loginLayer.classList.add('hidden');
  ui.app.classList.remove('hidden');
}

function setNotice(text = '', error = false) {
  ui.playerNotice.textContent = text;
  ui.playerNotice.classList.toggle('error', Boolean(error));
}

function setSettingsNotice(text = '', error = false) {
  ui.settingsNotice.textContent = text;
  ui.settingsNotice.classList.toggle('error', Boolean(error));
}

function toast(text) {
  ui.toast.textContent = text;
  ui.toast.classList.remove('hidden');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => ui.toast.classList.add('hidden'), 2600);
}

function formatBytes(bytes) {
  const n = Number(bytes || 0);
  if (!n) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = n; let i = 0;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i++; }
  return `${value.toFixed(i > 1 ? 1 : 0)} ${units[i]}`;
}

function mediaPayload(extra = {}) {
  return { mediaPath: state.mediaPath, mediaVersion: state.mediaVersion, ...extra };
}

function emitControl(event, payload = {}) {
  if (!state.socket?.connected) {
    setNotice('连接已断开：本次操作不会排队，重连后会恢复服务器的最新状态。', true);
    return false;
  }
  state.socket.emit(event, payload);
  return true;
}

async function bootstrap() {
  const session = await api('/api/session').catch(() => ({ authenticated: false }));
  if (!session.authenticated) return showLogin();
  state.nickname = session.nickname;
  state.participantId = session.participantId;
  state.settings = session.settings;
  startApp();
}

ui.loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  ui.loginError.textContent = '';
  try {
    const result = await api('/api/login', {
      method: 'POST',
      body: JSON.stringify({ nickname: ui.nicknameInput.value, password: ui.passwordInput.value }),
    });
    state.nickname = result.nickname;
    state.participantId = result.participantId;
    state.settings = result.settings;
    startApp();
  } catch (error) { ui.loginError.textContent = error.message; }
});

ui.logoutBtn.addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' }).catch(() => {});
  showLogin();
});

function startApp() {
  showApp();
  connectSocket();
  applySettings(state.settings);
  loadLibrary('');
  if (!state.settings?.webdav?.configured) openSettings();
}

function connectSocket() {
  state.socket?.disconnect();
  const socket = io({ transports: ['websocket', 'polling'], reconnection: true });
  state.socket = socket;

  socket.on('connect', () => {
    ui.socketBadge.textContent = '已连接';
    ui.socketBadge.classList.add('online');
    setNotice('');
    requestSync(true);
  });
  socket.on('disconnect', () => {
    ui.socketBadge.textContent = '重连中';
    ui.socketBadge.classList.remove('online');
  });
  socket.on('connect_error', (error) => {
    ui.socketBadge.textContent = '连接失败';
    ui.socketBadge.classList.remove('online');
    setNotice(`WebSocket：${error.message}`, true);
  });
  socket.on('room:full', (payload) => setNotice(payload?.message || '当前已有两个人在线', true));
  socket.on('room:snapshot', (snapshot) => applySnapshot(snapshot, true));
  socket.on('room:state', (snapshot) => applySnapshot(snapshot, false));
  socket.on('presence:update', renderPresence);
  socket.on('room:wait', (payload) => toast(`${payload?.nickname || '对方'}：等等我`));

  clearInterval(state.syncTimer);
  state.syncTimer = setInterval(() => requestSync(false), 4000);
}

function requestSync(force = false) {
  const socket = state.socket;
  if (!socket?.connected) return;
  const started = performance.now();
  socket.timeout(2500).emit('sync:request', (error, snapshot) => {
    if (error || !snapshot) return;
    const rtt = performance.now() - started;
    state.halfRttMs = Math.min(1000, Math.max(0, rtt / 2));
    applySnapshot(snapshot, force);
  });
}

function renderPresence(payload = {}) {
  const participants = Array.isArray(payload.participants) ? payload.participants : [];
  ui.onlineBadge.textContent = `${participants.length} / 2 在线`;
  ui.onlineBadge.classList.toggle('online', participants.length >= 2);
  const self = participants.find((item) => item.id === state.participantId);
  const peer = participants.find((item) => item.id !== state.participantId);
  ui.selfStatus.textContent = self ? '在线' : '重连中';
  ui.selfBuffering.textContent = state.buffering ? '正在缓冲' : '播放就绪';
  if (peer) state.lastPeerName = peer.nickname;
  ui.peerStatus.textContent = peer ? `${peer.nickname} · 在线` : (state.lastPeerName ? `${state.lastPeerName} · 离线` : '离线');
  ui.peerBuffering.textContent = peer ? (peer.buffering ? '对方正在缓冲' : '播放就绪') : '等待上线';
  ui.peerDot.className = `status-dot${peer ? (peer.buffering ? ' buffering' : ' online') : ''}`;
}

async function loadLibrary(relativePath = '') {
  const seq = ++state.librarySeq;
  state.libraryPath = relativePath;
  renderBreadcrumbs(relativePath);
  ui.libraryStatus.textContent = '正在读取 WebDAV...';
  ui.libraryList.replaceChildren();
  try {
    const result = await api(`/api/library?path=${encodeURIComponent(relativePath)}`);
    if (seq !== state.librarySeq) return;
    ui.libraryStatus.textContent = result.items.length ? `${result.items.length} 项` : '这里没有可播放视频';
    for (const item of result.items) ui.libraryList.appendChild(renderLibraryItem(item));
  } catch (error) {
    if (seq !== state.librarySeq) return;
    ui.libraryStatus.textContent = error.message;
    if (/WebDAV|配置|认证/.test(error.message)) openSettings();
  }
}

function renderBreadcrumbs(relativePath) {
  ui.breadcrumbs.replaceChildren();
  const crumbs = [{ label: '根目录', path: '' }];
  const parts = relativePath ? relativePath.split('/') : [];
  let current = '';
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    crumbs.push({ label: part, path: current });
  }
  for (const crumb of crumbs) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = crumb.label;
    button.addEventListener('click', () => loadLibrary(crumb.path));
    ui.breadcrumbs.appendChild(button);
  }
}

function renderLibraryItem(item) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `library-item${!item.isDir && item.path === state.mediaPath ? ' active' : ''}`;
  const icon = document.createElement('span');
  icon.className = 'file-icon';
  icon.textContent = item.isDir ? '▰' : '▶';
  const info = document.createElement('span');
  const strong = document.createElement('strong');
  strong.textContent = item.name;
  strong.title = item.name;
  const small = document.createElement('small');
  small.textContent = item.isDir ? '文件夹' : (formatBytes(item.size) || '视频');
  info.append(strong, small);
  const tail = document.createElement('small');
  tail.textContent = item.isDir ? '›' : (item.name.split('.').pop()?.toUpperCase() || '');
  button.append(icon, info, tail);
  button.addEventListener('click', () => {
    if (item.isDir) return loadLibrary(item.path);
    if (emitControl('media:select', { mediaPath: item.path, mediaName: item.name })) ui.libraryPanel.classList.remove('open');
  });
  return button;
}

ui.refreshLibraryBtn.addEventListener('click', () => loadLibrary(state.libraryPath));
ui.libraryToggle.addEventListener('click', () => ui.libraryPanel.classList.add('open'));
ui.closeLibraryBtn.addEventListener('click', () => ui.libraryPanel.classList.remove('open'));

function clearCorrection(restore = true) {
  clearTimeout(state.correctionTimer);
  state.correctionTimer = null;
  state.correctionToken++;
  if (restore && state.lastSnapshot && state.mediaReady) setProgrammaticRate(Number(state.lastSnapshot.rate || 1));
}

function setProgrammaticRate(rate) {
  const value = Math.min(4, Math.max(0.25, Number(rate || 1)));
  if (Math.abs(ui.video.playbackRate - value) < 0.001) return;
  state.expectedRate = { value, until: Date.now() + 1200 };
  ui.video.playbackRate = value;
  ui.rateSelect.value = String(Number(state.lastSnapshot?.rate || value));
}

function setProgrammaticSeek(target) {
  if (!Number.isFinite(target)) return;
  state.expectedSeek = { target, until: Date.now() + 1500 };
  try { ui.video.currentTime = Math.max(0, target); state.lastHardSeekAt = Date.now(); } catch {}
}

function setProgrammaticPause() {
  if (ui.video.paused) return;
  state.expectedPauseUntil = Date.now() + 1200;
  ui.video.pause();
}

function setProgrammaticPlay() {
  if (!ui.video.paused) return;
  state.expectedPlayUntil = Date.now() + 1500;
  ui.video.play()
    .then(() => ui.resumeOverlay.classList.add('hidden'))
    .catch(() => {
      state.expectedPlayUntil = 0;
      ui.resumeOverlay.classList.remove('hidden');
    });
}

function targetPosition(snapshot) {
  const base = Math.max(0, Number(snapshot.position || 0));
  if (!snapshot.playing) return base;
  return base + state.halfRttMs / 1000 * Number(snapshot.rate || 1);
}

function applySnapshot(snapshot, force = false) {
  if (!snapshot || typeof snapshot !== 'object') return;
  state.lastSnapshot = snapshot;
  if (!snapshot.media) {
    if (state.mediaPath) clearMedia();
    return;
  }
  const changed = snapshot.media.path !== state.mediaPath || Number(snapshot.mediaVersion) !== state.mediaVersion;
  if (changed) {
    loadMedia(snapshot);
    return;
  }
  if (state.sourceLoading || !state.mediaReady) return;
  applyPlayback(snapshot, force);
}

function loadMedia(snapshot) {
  const seq = ++state.loadSeq;
  state.mediaPath = snapshot.media.path;
  state.mediaVersion = Number(snapshot.mediaVersion || 0);
  state.sourceLoading = true;
  state.mediaReady = false;
  state.buffering = false;
  clearCorrection(false);
  setBuffering(false);
  ui.mediaTitle.textContent = snapshot.media.name || snapshot.media.path.split('/').pop();
  ui.emptyPlayer.classList.add('hidden');
  ui.resumeOverlay.classList.add('hidden');
  ui.syncBadge.textContent = '正在加载';
  ui.syncBadge.classList.remove('good');
  setNotice('正在从 WebDAV 获取视频直链…');

  ui.video.pause();
  ui.video.removeAttribute('src');
  ui.video.load();
  ui.video.src = `/api/media?path=${encodeURIComponent(state.mediaPath)}&v=${state.mediaVersion}`;
  ui.video.load();

  const onReady = () => {
    if (seq !== state.loadSeq) return;
    state.sourceLoading = false;
    state.mediaReady = true;
    setNotice('');
    ui.video.removeEventListener('loadedmetadata', onReady);
    requestSync(true);
    refreshActiveLibraryItem();
  };
  ui.video.addEventListener('loadedmetadata', onReady);
}

function clearMedia() {
  state.loadSeq++;
  state.mediaPath = '';
  state.mediaVersion = Number(state.lastSnapshot?.mediaVersion || state.mediaVersion + 1);
  state.sourceLoading = false;
  state.mediaReady = false;
  clearCorrection(false);
  setBuffering(false);
  ui.video.pause();
  ui.video.removeAttribute('src');
  ui.video.load();
  ui.mediaTitle.textContent = '选择一个视频开始';
  ui.emptyPlayer.classList.remove('hidden');
  ui.syncBadge.textContent = '等待视频';
  ui.syncBadge.classList.remove('good');
  setNotice('');
}

function applyPlayback(snapshot, force = false) {
  if (!state.mediaReady || snapshot.media?.path !== state.mediaPath || Number(snapshot.mediaVersion) !== state.mediaVersion) return;
  const desiredRate = Number(snapshot.rate || 1);
  const target = targetPosition(snapshot);
  const current = Number(ui.video.currentTime || 0);
  const drift = current - target;
  const absDrift = Math.abs(drift);

  if (force && !state.buffering) {
    clearCorrection(false);
    if (absDrift > 0.18) setProgrammaticSeek(target);
  } else if (!state.buffering && absDrift > 1.8 && Date.now() - state.lastHardSeekAt > 6000) {
    clearCorrection(false);
    setProgrammaticSeek(target);
  } else if (!state.buffering && snapshot.playing && absDrift > 0.35) {
    const adjust = Math.min(0.06, Math.max(0.02, absDrift * 0.03));
    const corrected = drift < 0 ? desiredRate + adjust : desiredRate - adjust;
    const token = ++state.correctionToken;
    setProgrammaticRate(corrected);
    clearTimeout(state.correctionTimer);
    state.correctionTimer = setTimeout(() => {
      if (token !== state.correctionToken) return;
      state.correctionTimer = null;
      setProgrammaticRate(Number(state.lastSnapshot?.rate || desiredRate));
    }, 1800);
  } else if (!state.correctionTimer) {
    setProgrammaticRate(desiredRate);
  }

  ui.rateSelect.value = String(desiredRate);
  ui.syncBadge.textContent = absDrift <= 0.25 ? '已对轴' : state.buffering ? `缓冲中 · 差 ${absDrift.toFixed(1)}s` : `校准 ${absDrift.toFixed(1)}s`;
  ui.syncBadge.classList.toggle('good', absDrift <= 0.25 && !state.buffering);

  if (snapshot.playing) setProgrammaticPlay();
  else setProgrammaticPause();
}

function refreshActiveLibraryItem() {
  for (const item of document.querySelectorAll('.library-item')) item.classList.remove('active');
  for (const strong of document.querySelectorAll('.library-item strong')) {
    if (strong.textContent === ui.mediaTitle.textContent) strong.closest('.library-item')?.classList.add('active');
  }
}

ui.video.addEventListener('play', () => {
  if (state.sourceLoading) return;
  if (Date.now() <= state.expectedPlayUntil) { state.expectedPlayUntil = 0; return; }
  emitControl('player:play', mediaPayload({ position: ui.video.currentTime }));
});

ui.video.addEventListener('pause', () => {
  if (state.sourceLoading) return;
  if (Date.now() <= state.expectedPauseUntil) { state.expectedPauseUntil = 0; return; }
  if (ui.video.ended || !state.mediaPath) return;
  emitControl('player:pause', mediaPayload({ position: ui.video.currentTime }));
});

ui.video.addEventListener('seeked', () => {
  if (state.sourceLoading || !state.mediaPath) return;
  const expected = state.expectedSeek;
  if (expected && Date.now() <= expected.until && Math.abs(ui.video.currentTime - expected.target) < 0.8) {
    state.expectedSeek = null;
    return;
  }
  state.expectedSeek = null;
  clearCorrection(false);
  emitControl('player:seek', mediaPayload({ position: ui.video.currentTime }));
});

ui.video.addEventListener('ratechange', () => {
  if (state.sourceLoading || !state.mediaPath) return;
  const expected = state.expectedRate;
  if (expected && Date.now() <= expected.until && Math.abs(ui.video.playbackRate - expected.value) < 0.01) {
    state.expectedRate = null;
    return;
  }
  state.expectedRate = null;
  clearTimeout(state.correctionTimer);
  state.correctionTimer = null;
  emitControl('player:rate', mediaPayload({ rate: ui.video.playbackRate }));
});

ui.video.addEventListener('ended', () => {
  if (state.mediaPath) emitControl('player:pause', mediaPayload({ position: ui.video.duration || ui.video.currentTime }));
});

function setBuffering(value) {
  const next = Boolean(value);
  if (state.buffering === next) return;
  state.buffering = next;
  ui.selfBuffering.textContent = next ? '正在缓冲' : '播放就绪';
  if (state.socket?.connected) state.socket.emit('presence:buffering', { buffering: next });
  if (!next) requestSync(false);
}

function beginBuffering() {
  if (ui.video.paused || state.sourceLoading || !state.mediaPath) return;
  clearTimeout(state.bufferTimer);
  state.bufferTimer = setTimeout(() => {
    setBuffering(true);
    clearCorrection(true);
  }, 300);
}

function endBuffering() {
  clearTimeout(state.bufferTimer);
  setBuffering(false);
}

ui.video.addEventListener('waiting', beginBuffering);
ui.video.addEventListener('stalled', beginBuffering);
ui.video.addEventListener('playing', endBuffering);
ui.video.addEventListener('canplay', endBuffering);
ui.video.addEventListener('error', () => {
  if (!state.mediaPath) return;
  state.sourceLoading = false;
  state.mediaReady = false;
  endBuffering();
  const code = ui.video.error?.code;
  const message = code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED
    ? '浏览器无法播放该视频。可能是编码/封装不受支持，或浏览器不接受该 WebDAV 的直连认证。建议优先使用 MP4（H.264 + AAC）。'
    : '视频直连失败。请先在设置中测试 WebDAV，并确认 123 云盘/WebDAV 允许当前浏览器直接读取该文件。';
  setNotice(message, true);
  ui.syncBadge.textContent = '播放失败';
  ui.syncBadge.classList.remove('good');
});

ui.resumeOverlay.addEventListener('click', () => {
  state.expectedPlayUntil = Date.now() + 1500;
  ui.video.play().then(() => ui.resumeOverlay.classList.add('hidden')).catch(() => {});
});

ui.waitBtn.addEventListener('click', () => emitControl('player:wait'));
ui.syncNowBtn.addEventListener('click', () => requestSync(true));
ui.rateSelect.addEventListener('change', () => {
  if (!state.mediaPath) return;
  clearCorrection(false);
  state.expectedRate = null;
  ui.video.playbackRate = Number(ui.rateSelect.value || 1);
});

function openSettings() {
  ui.settingsModal.classList.remove('hidden');
  loadSettings();
}

function closeSettings() { ui.settingsModal.classList.add('hidden'); }

ui.settingsBtn.addEventListener('click', openSettings);
ui.closeSettingsBtn.addEventListener('click', closeSettings);
ui.settingsModal.addEventListener('click', (event) => { if (event.target === ui.settingsModal) closeSettings(); });

async function loadSettings() {
  try {
    const result = await api('/api/settings');
    state.settings = result.settings;
    applySettings(result.settings);
  } catch (error) { setSettingsNotice(error.message, true); }
}

function applySettings(settings) {
  const webdav = settings?.webdav || {};
  ui.webdavUrl.value = webdav.url || '';
  ui.webdavUsername.value = webdav.username || '';
  ui.webdavPassword.value = '';
  ui.webdavPassword.placeholder = webdav.passwordSaved ? '已保存；留空保持不变' : 'WebDAV 密码 / 123 云盘应用密码';
  ui.webdavRoot.value = webdav.root || '/';
}

function formWebDav() {
  return {
    url: ui.webdavUrl.value.trim(),
    username: ui.webdavUsername.value.trim(),
    password: ui.webdavPassword.value,
    root: ui.webdavRoot.value.trim() || '/',
  };
}

ui.testWebdavBtn.addEventListener('click', async () => {
  setSettingsNotice('正在测试 WebDAV...');
  ui.testWebdavBtn.disabled = true;
  try {
    const result = await api('/api/webdav/test', { method: 'POST', body: JSON.stringify(formWebDav()) });
    setSettingsNotice(`连接成功：${result.result.displayName || result.result.url}`);
  } catch (error) { setSettingsNotice(error.message, true); }
  finally { ui.testWebdavBtn.disabled = false; }
});

ui.saveWebdavBtn.addEventListener('click', async () => {
  setSettingsNotice('正在验证并保存...');
  ui.saveWebdavBtn.disabled = true;
  try {
    const result = await api('/api/settings/webdav', { method: 'PUT', body: JSON.stringify(formWebDav()) });
    state.settings = result.settings;
    applySettings(result.settings);
    state.libraryPath = '';
    await loadLibrary('');
    setSettingsNotice('WebDAV 已保存。视频将通过浏览器直连，不经过本服务器。');
  } catch (error) { setSettingsNotice(error.message, true); }
  finally { ui.saveWebdavBtn.disabled = false; }
});

ui.saveSitePasswordBtn.addEventListener('click', async () => {
  const password = ui.newSitePassword.value;
  if (!password) return setSettingsNotice('请输入新访问密码', true);
  try {
    await api('/api/settings/password', { method: 'PUT', body: JSON.stringify({ password }) });
    ui.newSitePassword.value = '';
    setSettingsNotice('站点访问密码已修改。');
  } catch (error) { setSettingsNotice(error.message, true); }
});

bootstrap();
