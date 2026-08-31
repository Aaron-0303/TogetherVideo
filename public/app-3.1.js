const $ = (id) => document.getElementById(id);
const USER_PLAYBACK_RATES = Object.freeze([0.5, 0.75, 1, 1.25, 1.5, 2]);
const USER_SEEK_SETTLE_MS = 260;
const BARRIER_POSITION_TOLERANCE = 1.25;
const BARRIER_BUFFER_SECONDS = 1.0;
const BARRIER_READY_FALLBACK_MS = 10000;
const DESYNC_THRESHOLD_SECONDS = 2.5;
const DESYNC_SAMPLES = 3;

const ui = {
  loginLayer: $('loginLayer'), loginForm: $('loginForm'), nicknameInput: $('nicknameInput'), passwordInput: $('passwordInput'), loginError: $('loginError'),
  app: $('app'), socketBadge: $('socketBadge'), onlineBadge: $('onlineBadge'), logoutBtn: $('logoutBtn'), settingsBtn: $('settingsBtn'),
  libraryToggle: $('libraryToggle'), closeLibraryBtn: $('closeLibraryBtn'), libraryPanel: $('libraryPanel'), breadcrumbs: $('breadcrumbs'), libraryStatus: $('libraryStatus'), libraryList: $('libraryList'), refreshLibraryBtn: $('refreshLibraryBtn'),
  videoShell: $('videoShell'), video: $('video'), libmediaPlayer: $('libmediaPlayer'), emptyPlayer: $('emptyPlayer'), resumeOverlay: $('resumeOverlay'), mediaTitle: $('mediaTitle'), syncBadge: $('syncBadge'), playerNotice: $('playerNotice'),
  compatControls: $('compatControls'), compatPlayBtn: $('compatPlayBtn'), compatSeek: $('compatSeek'), compatTime: $('compatTime'), compatVolume: $('compatVolume'), compatFullscreenBtn: $('compatFullscreenBtn'),
  waitBtn: $('waitBtn'), syncNowBtn: $('syncNowBtn'), rateSelect: $('rateSelect'), selfStatus: $('selfStatus'), selfBuffering: $('selfBuffering'), peerStatus: $('peerStatus'), peerBuffering: $('peerBuffering'), peerDot: $('peerDot'),
  settingsModal: $('settingsModal'), closeSettingsBtn: $('closeSettingsBtn'), webdavUrl: $('webdavUrl'), webdavUsername: $('webdavUsername'), webdavPassword: $('webdavPassword'), webdavRoot: $('webdavRoot'), testWebdavBtn: $('testWebdavBtn'), saveWebdavBtn: $('saveWebdavBtn'), newSitePassword: $('newSitePassword'), saveSitePasswordBtn: $('saveSitePasswordBtn'), settingsNotice: $('settingsNotice'), toast: $('toast'),
};

try {
  if ('preservesPitch' in ui.video) ui.video.preservesPitch = true;
  if ('webkitPreservesPitch' in ui.video) ui.video.webkitPreservesPitch = true;
} catch {}

const player = new HybridMedia({
  video: ui.video,
  container: ui.libmediaPlayer,
  shell: ui.videoShell,
  controls: {
    root: ui.compatControls,
    play: ui.compatPlayBtn,
    seek: ui.compatSeek,
    time: ui.compatTime,
    volume: ui.compatVolume,
    fullscreen: ui.compatFullscreenBtn,
  },
});
window.TogetherMediaPlayer = player;

const state = {
  nickname: '', participantId: '', socket: null, settings: null,
  libraryPath: '', librarySeq: 0,
  mediaPath: '', mediaVersion: 0, sourceLoading: false, mediaReady: false, loadSeq: 0,
  lastSnapshot: null, lastRevision: -1, clockOffsetMs: 0, clockSamples: [],
  barrier: null, barrierReadySent: 0, barrierReadyTimer: null,
  expectedSeek: null, expectedPlay: false, expectedPause: false,
  userSeeking: false, userSeekTimer: null, scheduledStartTimer: null,
  buffering: false, syncTimer: null, syncSeq: 0, lastSyncSeq: 0, driftBadSamples: 0,
  lastPeerName: '', fallbackUnavailable: false,
};

function isUserPlaybackRate(value) {
  const rate = Number(value);
  return Number.isFinite(rate) && USER_PLAYBACK_RATES.some((allowed) => Math.abs(rate - allowed) < 1e-6);
}

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
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i += 1; }
  return `${value.toFixed(i > 1 ? 1 : 0)} ${units[i]}`;
}

function mediaPayload(extra = {}) {
  return { mediaPath: state.mediaPath, mediaVersion: state.mediaVersion, ...extra };
}

function emitControl(event, payload = {}) {
  if (!state.socket?.connected) {
    setNotice('连接已断开，本次操作未发送。重连后会读取房间最新状态。', true);
    return false;
  }
  state.socket.emit(event, payload);
  return true;
}

function clearStartTimer() {
  clearTimeout(state.scheduledStartTimer);
  state.scheduledStartTimer = null;
}

function clearBarrierReadyTimer() {
  clearTimeout(state.barrierReadyTimer);
  state.barrierReadyTimer = null;
}

function showLogin() {
  state.socket?.disconnect();
  clearInterval(state.syncTimer);
  clearStartTimer();
  clearBarrierReadyTimer();
  clearTimeout(state.userSeekTimer);
  ui.loginLayer.classList.remove('hidden');
  ui.app.classList.add('hidden');
  ui.settingsModal.classList.add('hidden');
}

function showApp() {
  ui.loginLayer.classList.add('hidden');
  ui.app.classList.remove('hidden');
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
  } catch (error) {
    ui.loginError.textContent = error.message;
  }
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

function addClockSample(serverNow, sentAt, receivedAt) {
  const server = Number(serverNow);
  if (!Number.isFinite(server)) return;
  const midpoint = (Number(sentAt) + Number(receivedAt)) / 2;
  const offset = server - midpoint;
  state.clockSamples.push(offset);
  while (state.clockSamples.length > 7) state.clockSamples.shift();
  const sorted = [...state.clockSamples].sort((a, b) => a - b);
  state.clockOffsetMs = sorted[Math.floor(sorted.length / 2)] || 0;
}

function estimatedServerNow() {
  return Date.now() + state.clockOffsetMs;
}

function connectSocket() {
  state.socket?.disconnect();
  const socket = io({ transports: ['websocket', 'polling'], reconnection: true });
  state.socket = socket;

  socket.on('connect', () => {
    ui.socketBadge.textContent = '已连接';
    ui.socketBadge.classList.add('online');
  });
  socket.on('disconnect', () => {
    ui.socketBadge.textContent = '重连中';
    ui.socketBadge.classList.remove('online');
    clearStartTimer();
  });
  socket.on('connect_error', (error) => {
    ui.socketBadge.textContent = '连接失败';
    ui.socketBadge.classList.remove('online');
    setNotice(`WebSocket：${error.message}`, true);
  });
  socket.on('room:full', (payload) => setNotice(payload?.message || '当前已有两个人在线', true));
  socket.on('room:snapshot', (snapshot) => applySnapshot(snapshot));
  socket.on('room:state', (snapshot) => applySnapshot(snapshot));
  socket.on('room:barrier', handleBarrier);
  socket.on('presence:update', renderPresence);
  socket.on('room:wait', (payload) => toast(`${payload?.nickname || '对方'}：等等我`));

  clearInterval(state.syncTimer);
  state.syncTimer = setInterval(requestMeasuredSync, 5000);
  setTimeout(requestMeasuredSync, 400);
}

function requestMeasuredSync() {
  const socket = state.socket;
  if (!socket?.connected) return;
  const seq = ++state.syncSeq;
  const sentAt = Date.now();
  socket.timeout(2500).emit('sync:request', (error, snapshot) => {
    const receivedAt = Date.now();
    if (error || !snapshot || seq < state.lastSyncSeq) return;
    state.lastSyncSeq = seq;
    addClockSample(snapshot.serverNow, sentAt, receivedAt);
    applySnapshot(snapshot, { measured: true, receivedAt });
  });
}

function renderPresence(payload = {}) {
  const participants = Array.isArray(payload.participants) ? payload.participants : [];
  ui.onlineBadge.textContent = `${participants.length} / 2 在线`;
  ui.onlineBadge.classList.toggle('online', participants.length >= 2);
  const self = participants.find((item) => item.id === state.participantId);
  const peer = participants.find((item) => item.id !== state.participantId);

  ui.selfStatus.textContent = self ? '在线' : '重连中';
  if (state.barrier?.phase === 'preparing') {
    ui.selfBuffering.textContent = self?.ready ? '已缓存，等待对方' : '正在缓存目标位置';
  } else {
    ui.selfBuffering.textContent = state.buffering ? '正在缓冲' : (state.mediaReady ? '播放就绪' : '等待媒体');
  }

  if (peer) state.lastPeerName = peer.nickname;
  ui.peerStatus.textContent = peer
    ? `${peer.nickname} · 在线`
    : (state.lastPeerName ? `${state.lastPeerName} · 离线` : '离线');
  if (!peer) ui.peerBuffering.textContent = '等待上线';
  else if (state.barrier?.phase === 'preparing') ui.peerBuffering.textContent = peer.ready ? '对方已准备' : '对方正在缓存';
  else ui.peerBuffering.textContent = peer.buffering ? '对方正在缓冲' : '播放就绪';
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
    if (emitControl('media:select', { mediaPath: item.path, mediaName: item.name })) {
      ui.libraryPanel.classList.remove('open');
    }
  });
  return button;
}

ui.refreshLibraryBtn.addEventListener('click', () => loadLibrary(state.libraryPath));
ui.libraryToggle.addEventListener('click', () => ui.libraryPanel.classList.add('open'));
ui.closeLibraryBtn.addEventListener('click', () => ui.libraryPanel.classList.remove('open'));

function pauseLocal() {
  if (player.paused) return;
  state.expectedPause = true;
  player.pause();
}

function setLocalRate(rate) {
  const value = isUserPlaybackRate(rate) ? Number(rate) : 1;
  if (Math.abs(Number(player.playbackRate || 1) - value) > 0.001) player.playbackRate = value;
  ui.rateSelect.value = String(value);
}

function setProgrammaticSeek(target) {
  const value = Math.max(0, Number(target || 0));
  if (!Number.isFinite(value)) return;
  const duration = Number(player.duration);
  const bounded = Number.isFinite(duration) && duration > 0
    ? Math.min(Math.max(0, duration - 0.05), value)
    : value;
  if (Math.abs(Number(player.currentTime || 0) - bounded) <= 0.12) {
    state.expectedSeek = null;
    checkBarrierReady();
    return;
  }
  state.expectedSeek = { target: bounded, barrierId: state.barrier?.id || 0 };
  try {
    player.currentTime = bounded;
  } catch {
    state.expectedSeek = null;
  }
}

function bufferedEnough() {
  const ahead = Number(player.getBufferedAhead?.());
  if (Number.isFinite(ahead) && ahead >= BARRIER_BUFFER_SECONDS) return true;
  return player.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA;
}

function barrierPositionReady(barrier = state.barrier) {
  if (!barrier) return false;
  return Math.abs(Number(player.currentTime || 0) - Number(barrier.target || 0)) <= BARRIER_POSITION_TOLERANCE;
}

function sendBarrierReady() {
  const barrier = state.barrier;
  if (!barrier || barrier.phase !== 'preparing' || state.barrierReadySent === barrier.id) return;
  state.barrierReadySent = barrier.id;
  clearBarrierReadyTimer();
  setBuffering(false);
  emitControl('player:ready', {
    barrierId: barrier.id,
    mediaVersion: state.mediaVersion,
    position: Number(player.currentTime || 0),
    bufferedAhead: Number(player.getBufferedAhead?.()),
    readyState: player.readyState,
  });
  ui.syncBadge.textContent = '已准备 · 等待对方';
}

function checkBarrierReady({ fallback = false } = {}) {
  const barrier = state.barrier;
  if (!barrier || barrier.phase !== 'preparing') return;
  if (!state.mediaReady || state.sourceLoading || player.seeking || state.userSeeking) return;
  if (!barrierPositionReady(barrier)) return;
  if (bufferedEnough() || (fallback && player.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA)) {
    sendBarrierReady();
  }
}

function prepareBarrier(barrier) {
  if (!barrier || barrier.phase !== 'preparing') return;
  if (!state.mediaPath || Number(barrier.mediaVersion) !== state.mediaVersion) return;
  clearStartTimer();
  pauseLocal();
  setLocalRate(Number(state.lastSnapshot?.rate || 1));
  state.driftBadSamples = 0;
  ui.syncBadge.textContent = '同步准备 · 双方缓存中';
  ui.syncBadge.classList.remove('good');
  setNotice(barrier.reason === 'join'
    ? '对方加入，已暂停。双方缓存到同一位置后会同时继续播放。'
    : barrier.reason === 'seek'
      ? '进度已跳转并暂停，等待双方缓存完成后同时播放。'
      : barrier.reason === 'buffering'
        ? '检测到持续缓冲，已暂停双方并重新准备。'
        : '正在等待双方准备完成…');

  if (!state.mediaReady || state.sourceLoading) return;
  setProgrammaticSeek(Number(barrier.target || 0));
  clearBarrierReadyTimer();
  state.barrierReadyTimer = setTimeout(() => checkBarrierReady({ fallback: true }), BARRIER_READY_FALLBACK_MS);
  checkBarrierReady();
}

function scheduleSynchronizedStart(payload) {
  clearStartTimer();
  clearBarrierReadyTimer();
  const startAt = Number(payload.startAt || state.lastSnapshot?.startAt || 0);
  if (!Number.isFinite(startAt) || !startAt) return;
  const rate = Number(payload.rate || state.lastSnapshot?.rate || 1);
  setLocalRate(rate);
  const delay = Math.max(0, startAt - estimatedServerNow());
  ui.syncBadge.textContent = `双方已准备 · ${(delay / 1000).toFixed(1)}s 后播放`;
  setNotice('双方缓存完成，即将同时播放。');

  state.scheduledStartTimer = setTimeout(() => {
    state.scheduledStartTimer = null;
    state.expectedPlay = true;
    player.play()
      .then(() => {
        ui.resumeOverlay.classList.add('hidden');
        setNotice('');
      })
      .catch(() => {
        state.expectedPlay = false;
        ui.resumeOverlay.textContent = '点击开启声音并加入同步播放';
        ui.resumeOverlay.classList.remove('hidden');
      });
  }, delay);
}

function handleBarrier(payload = {}) {
  const phase = String(payload.phase || '');
  if (phase === 'cancelled' || phase === 'running') {
    if (!state.barrier || !payload.id || Number(payload.id) === Number(state.barrier.id)) {
      state.barrier = null;
      state.barrierReadySent = 0;
      clearBarrierReadyTimer();
    }
    if (phase === 'running') {
      ui.syncBadge.textContent = '同步播放';
      ui.syncBadge.classList.add('good');
    }
    return;
  }

  if (phase === 'preparing') {
    const previousId = Number(state.barrier?.id || 0);
    state.barrier = { ...payload, phase };
    if (Number(payload.id) !== previousId) state.barrierReadySent = 0;
    prepareBarrier(state.barrier);
    renderPresence({ participants: payload.participants || [] });
    return;
  }

  if (phase === 'starting') {
    state.barrier = { ...payload, phase };
    scheduleSynchronizedStart(payload);
  }
}

function targetAtReceive(snapshot, receivedAt = Date.now()) {
  let target = Math.max(0, Number(snapshot.position || 0));
  if (!snapshot.playing) return target;
  const serverNowAtReceive = receivedAt + state.clockOffsetMs;
  const elapsed = Math.max(0, serverNowAtReceive - Number(snapshot.serverNow || serverNowAtReceive)) / 1000;
  target += elapsed * Number(snapshot.rate || 1);
  return target;
}

function applySnapshot(snapshot, options = {}) {
  if (!snapshot || typeof snapshot !== 'object') return;
  const revision = Number(snapshot.revision || 0);
  if (revision < state.lastRevision) return;
  state.lastRevision = Math.max(state.lastRevision, revision);
  state.lastSnapshot = snapshot;

  if (!snapshot.media) {
    if (state.mediaPath) clearMedia();
    return;
  }

  const changed = snapshot.media.path !== state.mediaPath
    || Number(snapshot.mediaVersion) !== state.mediaVersion;
  if (changed) {
    loadMedia(snapshot);
    return;
  }
  if (state.sourceLoading || !state.mediaReady) return;

  setLocalRate(Number(snapshot.rate || 1));

  // During a barrier the barrier message owns seeking/starting. A plain room
  // snapshot must never race it with another currentTime assignment.
  if (state.barrier) {
    if (state.barrier.phase === 'preparing') prepareBarrier(state.barrier);
    return;
  }

  if (!snapshot.playing) {
    pauseLocal();
    if (['pause', 'wait', 'server-restart', 'select'].includes(String(snapshot.reason || ''))) {
      const target = Number(snapshot.position || 0);
      if (Math.abs(Number(player.currentTime || 0) - target) > 0.75) setProgrammaticSeek(target);
    }
    ui.syncBadge.textContent = '已暂停';
    ui.syncBadge.classList.remove('good');
    return;
  }

  if (Number(snapshot.startAt || 0) > estimatedServerNow()) {
    scheduleSynchronizedStart({ startAt: snapshot.startAt, rate: snapshot.rate });
    return;
  }

  if (player.paused) {
    state.expectedPlay = true;
    player.play().catch(() => {
      state.expectedPlay = false;
      ui.resumeOverlay.classList.remove('hidden');
    });
  }

  if (options.measured) {
    const target = targetAtReceive(snapshot, options.receivedAt || Date.now());
    const drift = Number(player.currentTime || 0) - target;
    if (Math.abs(drift) >= DESYNC_THRESHOLD_SECONDS) state.driftBadSamples += 1;
    else state.driftBadSamples = 0;

    if (state.driftBadSamples >= DESYNC_SAMPLES) {
      state.driftBadSamples = 0;
      emitControl('player:desync', mediaPayload({
        position: player.currentTime,
        drift,
      }));
    }
    ui.syncBadge.textContent = Math.abs(drift) < 0.8 ? '同步播放' : `播放中 · 差 ${Math.abs(drift).toFixed(1)}s`;
    ui.syncBadge.classList.toggle('good', Math.abs(drift) < 0.8 && !state.buffering);
  }
}

function loadMedia(snapshot) {
  const seq = ++state.loadSeq;
  clearStartTimer();
  clearBarrierReadyTimer();
  clearTimeout(state.userSeekTimer);
  state.mediaPath = snapshot.media.path;
  state.mediaVersion = Number(snapshot.mediaVersion || 0);
  state.sourceLoading = true;
  state.mediaReady = false;
  state.expectedSeek = null;
  state.userSeeking = false;
  state.fallbackUnavailable = false;
  setBuffering(false);
  ui.mediaTitle.textContent = snapshot.media.name || snapshot.media.path.split('/').pop();
  ui.emptyPlayer.classList.add('hidden');
  ui.resumeOverlay.classList.add('hidden');
  ui.syncBadge.textContent = '正在加载';
  ui.syncBadge.classList.remove('good');
  setNotice('正在获取媒体地址…');

  player.pause();
  player.removeAttribute('src');
  player.src = `/api/media?path=${encodeURIComponent(state.mediaPath)}&v=${state.mediaVersion}`;
  player.load();

  const onMetadata = () => {
    player.removeEventListener('loadedmetadata', onMetadata);
    if (seq !== state.loadSeq) return;
    state.sourceLoading = false;
    state.mediaReady = true;
    setLocalRate(Number(state.lastSnapshot?.rate || 1));
    setNotice('媒体已加载，正在准备播放。');
    refreshActiveLibraryItem();

    if (state.barrier?.phase === 'preparing') prepareBarrier(state.barrier);
    else applySnapshot(state.lastSnapshot || snapshot);
  };
  player.addEventListener('loadedmetadata', onMetadata);
}

function clearMedia() {
  state.loadSeq += 1;
  clearStartTimer();
  clearBarrierReadyTimer();
  clearTimeout(state.userSeekTimer);
  state.mediaPath = '';
  state.mediaReady = false;
  state.sourceLoading = false;
  state.expectedSeek = null;
  state.userSeeking = false;
  state.barrier = null;
  state.barrierReadySent = 0;
  setBuffering(false);
  player.pause();
  player.removeAttribute('src');
  player.load();
  ui.mediaTitle.textContent = '选择一个视频开始';
  ui.emptyPlayer.classList.remove('hidden');
  ui.syncBadge.textContent = '等待视频';
  ui.syncBadge.classList.remove('good');
  setNotice('');
}

function refreshActiveLibraryItem() {
  for (const item of document.querySelectorAll('.library-item')) item.classList.remove('active');
  for (const strong of document.querySelectorAll('.library-item strong')) {
    if (strong.textContent === ui.mediaTitle.textContent) strong.closest('.library-item')?.classList.add('active');
  }
}

function setBuffering(value) {
  const next = Boolean(value);
  if (state.buffering === next) return;
  state.buffering = next;
  if (state.socket?.connected) state.socket.emit('presence:buffering', { buffering: next });
}

function beginBuffering() {
  if (!state.mediaPath || state.sourceLoading || player.paused || player.seeking || state.barrier) return;
  setBuffering(true);
  ui.syncBadge.textContent = '检测到缓冲';
  ui.syncBadge.classList.remove('good');
}

function endBuffering() {
  if (!state.buffering) return;
  if (player.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA || Number(player.getBufferedAhead?.()) > 0.5) {
    setBuffering(false);
  }
}

player.addEventListener('fallbackstart', () => {
  if (!state.mediaPath) return;
  ui.syncBadge.textContent = '切换兼容模式';
  setNotice('原生播放器无法解码，正在启动兼容播放器…');
});

player.addEventListener('fallbackunavailable', () => {
  state.fallbackUnavailable = true;
});

player.addEventListener('firstrender', () => {
  if (state.barrier?.phase === 'preparing') checkBarrierReady();
});

player.addEventListener('play', () => {
  if (state.sourceLoading || !state.mediaPath) return;
  if (state.expectedPlay) {
    state.expectedPlay = false;
    return;
  }

  // A manual play is a room transaction, not permission for this browser to run
  // ahead. Pause locally and let the server open a barrier for all participants.
  pauseLocal();
  emitControl('player:play', mediaPayload({ position: player.currentTime }));
});

player.addEventListener('pause', () => {
  if (state.sourceLoading || !state.mediaPath) return;
  if (state.expectedPause) {
    state.expectedPause = false;
    return;
  }
  if (state.userSeeking || player.seeking || state.barrier) return;
  if (player.ended) return;
  emitControl('player:pause', mediaPayload({ position: player.currentTime }));
});

player.addEventListener('seeking', () => {
  if (!state.mediaPath || state.sourceLoading) return;
  if (state.expectedSeek) return;

  // User scrubbing immediately pauses this browser. The server will pause the
  // room and create a barrier after the final seeked position settles.
  state.userSeeking = true;
  pauseLocal();
  clearTimeout(state.userSeekTimer);
  ui.syncBadge.textContent = '拖动中 · 等待双方重新缓存';
  ui.syncBadge.classList.remove('good');
});

function commitUserSeek() {
  state.userSeekTimer = null;
  if (!state.userSeeking || player.seeking || state.sourceLoading || !state.mediaPath) return;
  const target = Number(player.currentTime || 0);
  state.userSeeking = false;
  emitControl('player:seek', mediaPayload({ position: target }));
}

player.addEventListener('seeked', () => {
  if (!state.mediaPath || state.sourceLoading) return;
  const expected = state.expectedSeek;
  if (expected) {
    const current = Number(player.currentTime || 0);
    if (Math.abs(current - Number(expected.target || 0)) <= BARRIER_POSITION_TOLERANCE) {
      state.expectedSeek = null;
      checkBarrierReady();
      return;
    }
    // A real user scrub superseded a programmatic target.
    state.expectedSeek = null;
    state.userSeeking = true;
  }

  if (state.userSeeking) {
    clearTimeout(state.userSeekTimer);
    state.userSeekTimer = setTimeout(commitUserSeek, USER_SEEK_SETTLE_MS);
  }
});

player.addEventListener('waiting', beginBuffering);
player.addEventListener('stalled', beginBuffering);
player.addEventListener('playing', endBuffering);
player.addEventListener('canplay', () => {
  endBuffering();
  checkBarrierReady();
});
player.addEventListener('loadeddata', checkBarrierReady);
player.addEventListener('progress', () => {
  endBuffering();
  checkBarrierReady();
});

player.addEventListener('ended', () => {
  setBuffering(false);
  clearStartTimer();
  if (state.mediaPath) emitControl('player:pause', mediaPayload({ position: player.duration || player.currentTime }));
});

player.addEventListener('error', () => {
  if (!state.mediaPath) return;
  setBuffering(false);
  state.sourceLoading = false;
  state.mediaReady = false;
  const code = player.error?.code;
  const message = state.fallbackUnavailable
    ? 'Safari 原生媒体管线无法播放该文件，请检查视频封装与编码。'
    : code === MediaError.MEDIA_ERR_NETWORK
      ? '视频网络读取失败，请重试或检查 123 云盘直链。'
      : code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED
        ? '浏览器无法解码该视频，请查看媒体诊断。'
        : '视频读取或解码失败，请查看媒体诊断。';
  setNotice(message, true);
  ui.syncBadge.textContent = '播放失败';
  ui.syncBadge.classList.remove('good');
});

ui.resumeOverlay.addEventListener('click', () => {
  if (!state.mediaPath) return;
  state.expectedPlay = true;
  player.play()
    .then(() => ui.resumeOverlay.classList.add('hidden'))
    .catch(() => { state.expectedPlay = false; });
});

ui.waitBtn.addEventListener('click', () => emitControl('player:wait'));
ui.syncNowBtn.addEventListener('click', () => {
  if (!state.mediaPath) return;
  emitControl('player:desync', mediaPayload({ position: player.currentTime, manual: true }));
});
ui.rateSelect.addEventListener('change', () => {
  if (!state.mediaPath) return;
  const rate = Number(ui.rateSelect.value || 1);
  if (!isUserPlaybackRate(rate)) return;
  setLocalRate(rate);
  emitControl('player:rate', mediaPayload({ rate }));
});

function openSettings() {
  ui.settingsModal.classList.remove('hidden');
  loadSettings();
}
function closeSettings() { ui.settingsModal.classList.add('hidden'); }
ui.settingsBtn.addEventListener('click', openSettings);
ui.closeSettingsBtn.addEventListener('click', closeSettings);
ui.settingsModal.addEventListener('click', (event) => {
  if (event.target === ui.settingsModal) closeSettings();
});

async function loadSettings() {
  try {
    const result = await api('/api/settings');
    state.settings = result.settings;
    applySettings(result.settings);
  } catch (error) {
    setSettingsNotice(error.message, true);
  }
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
    const result = await api('/api/webdav/test', {
      method: 'POST',
      body: JSON.stringify(formWebDav()),
    });
    setSettingsNotice(result.result.message || 'WebDAV 连接成功');
  } catch (error) {
    setSettingsNotice(error.message, true);
  } finally {
    ui.testWebdavBtn.disabled = false;
  }
});

ui.saveWebdavBtn.addEventListener('click', async () => {
  setSettingsNotice('正在验证并保存...');
  ui.saveWebdavBtn.disabled = true;
  try {
    const result = await api('/api/settings/webdav', {
      method: 'PUT',
      body: JSON.stringify(formWebDav()),
    });
    state.settings = result.settings;
    applySettings(result.settings);
    state.libraryPath = '';
    await loadLibrary('');
    setSettingsNotice('WebDAV 已保存。视频仍由浏览器直接读取 123，服务器不代理视频正文。');
  } catch (error) {
    setSettingsNotice(error.message, true);
  } finally {
    ui.saveWebdavBtn.disabled = false;
  }
});

ui.saveSitePasswordBtn.addEventListener('click', async () => {
  const password = ui.newSitePassword.value;
  if (!password) return setSettingsNotice('请输入新访问密码', true);
  try {
    await api('/api/settings/password', {
      method: 'PUT',
      body: JSON.stringify({ password }),
    });
    ui.newSitePassword.value = '';
    setSettingsNotice('站点访问密码已修改。');
  } catch (error) {
    setSettingsNotice(error.message, true);
  }
});

bootstrap();
