const $ = (id) => document.getElementById(id);
const USER_PLAYBACK_RATES = Object.freeze([0.5, 0.75, 1, 1.25, 1.5, 2]);
const SEEK_GRACE_MS = 6000;
const STARTUP_GRACE_MS = 7000;
const FIRST_FRAME_GRACE_MS = 4000;
const SEEK_COMMIT_DELAY_MS = 320;
const PROGRAMMATIC_SEEK_TOLERANCE = 1.25;

const ui = {
  loginLayer: $('loginLayer'), loginForm: $('loginForm'), nicknameInput: $('nicknameInput'), passwordInput: $('passwordInput'), loginError: $('loginError'),
  app: $('app'), socketBadge: $('socketBadge'), onlineBadge: $('onlineBadge'), logoutBtn: $('logoutBtn'), settingsBtn: $('settingsBtn'),
  libraryToggle: $('libraryToggle'), closeLibraryBtn: $('closeLibraryBtn'), libraryPanel: $('libraryPanel'), breadcrumbs: $('breadcrumbs'), libraryStatus: $('libraryStatus'), libraryList: $('libraryList'), refreshLibraryBtn: $('refreshLibraryBtn'),
  videoShell: $('videoShell'), video: $('video'), libmediaPlayer: $('libmediaPlayer'), emptyPlayer: $('emptyPlayer'), resumeOverlay: $('resumeOverlay'), mediaTitle: $('mediaTitle'), syncBadge: $('syncBadge'), playerNotice: $('playerNotice'),
  compatControls: $('compatControls'), compatPlayBtn: $('compatPlayBtn'), compatSeek: $('compatSeek'), compatTime: $('compatTime'), compatVolume: $('compatVolume'), compatFullscreenBtn: $('compatFullscreenBtn'),
  waitBtn: $('waitBtn'), syncNowBtn: $('syncNowBtn'), rateSelect: $('rateSelect'), selfStatus: $('selfStatus'), selfBuffering: $('selfBuffering'), peerStatus: $('peerStatus'), peerBuffering: $('peerBuffering'), peerDot: $('peerDot'),
  settingsModal: $('settingsModal'), closeSettingsBtn: $('closeSettingsBtn'), webdavUrl: $('webdavUrl'), webdavUsername: $('webdavUsername'), webdavPassword: $('webdavPassword'), webdavRoot: $('webdavRoot'), testWebdavBtn: $('testWebdavBtn'), saveWebdavBtn: $('saveWebdavBtn'), newSitePassword: $('newSitePassword'), saveSitePasswordBtn: $('saveSitePasswordBtn'), settingsNotice: $('settingsNotice'), toast: $('toast'),
};

// Keep audio pitch natural during the very small temporary rate corrections.
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

const syncReconciler = new SyncPolicy.Reconciler();
const mediaRecovery = MediaRecovery.createTracker();
window.TogetherMediaRecovery = mediaRecovery;

const state = {
  nickname: '', participantId: '', socket: null, settings: null,
  libraryPath: '', librarySeq: 0,
  mediaPath: '', mediaVersion: 0, sourceLoading: false, mediaReady: false, loadSeq: 0,
  lastSnapshot: null, lastRevision: -1, halfRttMs: 0,
  buffering: false, recoveryCheckTimer: null, recoveryReloadTimer: null, stallGraceTimer: null,
  expectedPlay: false, expectedPause: false, expectedSeek: null, expectedRate: null,
  syncTimer: null, syncSeq: 0, lastSyncSeq: 0, lastPeerName: '',
  seeking: false, seekOrigin: '', seekGraceUntil: 0, userSeekCommitTimer: null,
  fallbackUnavailable: false,
};

function isUserPlaybackRate(value) {
  const rate = Number(value);
  return Number.isFinite(rate) && USER_PLAYBACK_RATES.some((allowed) => Math.abs(allowed - rate) < 1e-6);
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

function showLogin() {
  state.socket?.disconnect();
  clearInterval(state.syncTimer);
  clearRecoveryTimers();
  clearTimeout(state.userSeekCommitTimer);
  state.userSeekCommitTimer = null;
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
    // The server always sends room:snapshot on connection. Do not immediately
    // issue a second forced sync here: on a late join this used to race the
    // initial media load and could produce two back-to-back seeks.
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
  socket.on('room:snapshot', (snapshot) => applySnapshot(snapshot, true, false));
  socket.on('room:state', (snapshot) => applySnapshot(snapshot, false, false));
  socket.on('presence:update', renderPresence);
  socket.on('room:wait', (payload) => toast(`${payload?.nickname || '对方'}：等等我`));
  socket.on('room:buffering-hold', (payload) => toast(payload?.message || '对方持续缓冲，已暂时一起暂停'));
  socket.on('room:buffering-resume', (payload) => toast(payload?.message || '双方已就绪，继续播放'));

  clearInterval(state.syncTimer);
  state.syncTimer = setInterval(() => requestSync(false), 1000);
}

function requestSync(force = false) {
  const socket = state.socket;
  if (!socket?.connected) return;
  const seq = ++state.syncSeq;
  const started = performance.now();
  socket.timeout(2500).emit('sync:request', (error, snapshot) => {
    if (error || !snapshot || seq < state.lastSyncSeq) return;
    state.lastSyncSeq = seq;
    state.halfRttMs = syncReconciler.sampleRtt(performance.now() - started);
    applySnapshot(snapshot, force, true);
  });
}

function localMediaStatus() {
  if (state.sourceLoading) return '正在准备媒体';
  if (state.seeking || player.seeking) return '正在跳转';
  if (state.buffering) return '正在缓冲';
  const phase = mediaRecovery.snapshot().phase;
  if (phase === 'recovering') return '恢复中';
  if (phase === 'stabilizing') return '验证稳定播放';
  return state.mediaReady ? '播放就绪' : '等待媒体';
}

function renderPresence(payload = {}) {
  const participants = Array.isArray(payload.participants) ? payload.participants : [];
  ui.onlineBadge.textContent = `${participants.length} / 2 在线`;
  ui.onlineBadge.classList.toggle('online', participants.length >= 2);
  const self = participants.find((item) => item.id === state.participantId);
  const peer = participants.find((item) => item.id !== state.participantId);
  ui.selfStatus.textContent = self ? '在线' : '重连中';
  ui.selfBuffering.textContent = localMediaStatus();
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
  syncReconciler.stopCorrection?.();
  if (restore && state.lastSnapshot && state.mediaReady) setProgrammaticRate(Number(state.lastSnapshot.rate || 1));
}

function setProgrammaticRate(rate) {
  const value = Math.min(2, Math.max(0.5, Number(rate || 1)));
  if (Math.abs(player.playbackRate - value) < 0.001) return;
  // Do not rely on a short timeout here. Safari can delay ratechange events;
  // matching the actual value is enough to identify a programmatic change.
  state.expectedRate = { value };
  player.playbackRate = value;
  ui.rateSelect.value = String(Number(state.lastSnapshot?.rate || value));
}

function armSeekGrace(durationMs = SEEK_GRACE_MS) {
  const duration = Math.max(0, Number(durationMs || 0));
  state.seekGraceUntil = Math.max(state.seekGraceUntil, Date.now() + duration);

  // An intentional seek or initial catch-up is not network buffering. Clear any
  // stale shared-buffer state so one viewer scrubbing never pauses the other.
  clearTimeout(state.recoveryCheckTimer);
  state.recoveryCheckTimer = null;
  mediaRecovery.cancelStall({ keepAttempts: true });
  if (state.buffering) setBuffering(false, { resync: false });

  clearTimeout(state.stallGraceTimer);
  const remaining = Math.max(0, state.seekGraceUntil - Date.now());
  state.stallGraceTimer = setTimeout(() => {
    state.stallGraceTimer = null;
    if (!state.mediaPath || state.sourceLoading || player.paused || player.seeking || state.seeking) return;
    if (player.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) beginMediaStall();
  }, remaining + 60);
}

function setProgrammaticSeek(target) {
  if (!Number.isFinite(target)) return;
  const duration = Number(player.duration);
  const upper = Number.isFinite(duration) && duration > 0 ? Math.max(0, duration - 0.05) : Number.POSITIVE_INFINITY;
  const value = Math.min(upper, Math.max(0, target));
  if (Math.abs(Number(player.currentTime || 0) - value) < 0.08) return;

  clearTimeout(state.userSeekCommitTimer);
  state.userSeekCommitTimer = null;
  state.expectedSeek = { target: value, issuedAt: Date.now() };
  state.seekOrigin = 'programmatic';
  armSeekGrace(SEEK_GRACE_MS);
  try {
    player.currentTime = value;
    syncReconciler.noteHardSeek();
  } catch {
    state.expectedSeek = null;
    state.seekOrigin = '';
  }
}

function setProgrammaticPause() {
  if (player.paused) return;
  state.expectedPause = true;
  player.pause();
}

function setProgrammaticPlay() {
  if (!player.paused) return;
  state.expectedPlay = true;
  player.play()
    .then(() => ui.resumeOverlay.classList.add('hidden'))
    .catch(() => {
      state.expectedPlay = false;
      ui.resumeOverlay.classList.remove('hidden');
    });
}

function targetPosition(snapshot) {
  const base = Math.max(0, Number(snapshot.position || 0));
  if (!snapshot.playing) return base;
  return base + state.halfRttMs / 1000 * Number(snapshot.rate || 1);
}

function recoveryLabel() {
  const phase = mediaRecovery.snapshot().phase;
  if (phase === 'stalled') return '媒体卡顿';
  if (phase === 'recovering') return '媒体恢复中';
  if (phase === 'stabilizing') return '验证稳定播放';
  if (phase === 'preparing') return '准备媒体';
  return '';
}

function applySnapshot(snapshot, force = false, sampled = false) {
  if (!snapshot || typeof snapshot !== 'object') return;
  const revision = Number(snapshot.revision || 0);
  if (revision < state.lastRevision) return;
  if (revision > state.lastRevision) state.lastRevision = revision;
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
  applyPlayback(snapshot, force, sampled);
}

function loadMedia(snapshot) {
  const seq = ++state.loadSeq;
  clearRecoveryTimers();
  clearTimeout(state.userSeekCommitTimer);
  state.userSeekCommitTimer = null;
  mediaRecovery.reset({ preparing: true });
  state.mediaPath = snapshot.media.path;
  state.mediaVersion = Number(snapshot.mediaVersion || 0);
  state.sourceLoading = true;
  state.mediaReady = false;
  state.fallbackUnavailable = false;
  state.expectedSeek = null;
  state.expectedPlay = false;
  state.expectedPause = false;
  state.seeking = false;
  state.seekOrigin = '';
  clearCorrection(false);
  setBuffering(false, { resync: false });
  armSeekGrace(STARTUP_GRACE_MS);
  ui.mediaTitle.textContent = snapshot.media.name || snapshot.media.path.split('/').pop();
  ui.emptyPlayer.classList.add('hidden');
  ui.resumeOverlay.classList.add('hidden');
  ui.syncBadge.textContent = '正在加载';
  ui.syncBadge.classList.remove('good');
  setNotice('正在获取 123 媒体地址…');

  player.pause();
  player.removeAttribute('src');
  player.src = `/api/media?path=${encodeURIComponent(state.mediaPath)}&v=${state.mediaVersion}`;
  player.load();

  const onReady = () => {
    player.removeEventListener('loadedmetadata', onReady);
    if (seq !== state.loadSeq) return;
    state.sourceLoading = false;
    state.mediaReady = true;
    if (player.mode === 'libmedia') setNotice('兼容播放器已解析媒体，正在准备首帧。');
    else setNotice('媒体信息已就绪，正在准备播放。');

    // Late joiners perform exactly one forced catch-up after metadata. Starting
    // playback and rendering the first frame must not trigger a second hard seek.
    requestSync(true);
    refreshActiveLibraryItem();
  };
  player.addEventListener('loadedmetadata', onReady);
}

function clearMedia() {
  state.loadSeq += 1;
  clearRecoveryTimers();
  clearTimeout(state.userSeekCommitTimer);
  state.userSeekCommitTimer = null;
  mediaRecovery.reset();
  state.mediaPath = '';
  state.mediaVersion = Number(state.lastSnapshot?.mediaVersion || state.mediaVersion + 1);
  state.sourceLoading = false;
  state.mediaReady = false;
  state.seeking = false;
  state.seekOrigin = '';
  state.seekGraceUntil = 0;
  state.expectedSeek = null;
  state.expectedPlay = false;
  state.expectedPause = false;
  state.fallbackUnavailable = false;
  clearCorrection(false);
  setBuffering(false, { resync: false });
  player.pause();
  player.removeAttribute('src');
  player.load();
  ui.mediaTitle.textContent = '选择一个视频开始';
  ui.emptyPlayer.classList.remove('hidden');
  ui.syncBadge.textContent = '等待视频';
  ui.syncBadge.classList.remove('good');
  setNotice('');
}

function applyPlayback(snapshot, force = false, sampled = false) {
  if (!state.mediaReady || snapshot.media?.path !== state.mediaPath || Number(snapshot.mediaVersion) !== state.mediaVersion) return;
  const desiredRate = Number(snapshot.rate || 1);
  const target = targetPosition(snapshot);
  const current = Number(player.currentTime || 0);
  const drift = current - target;
  const absDrift = Math.abs(drift);

  // During recovery, playback continuity wins over timeline precision.
  if (mediaRecovery.shouldFreezeSync() && snapshot.reason !== 'seek') {
    setProgrammaticRate(desiredRate);
    ui.rateSelect.value = String(desiredRate);
    ui.syncBadge.textContent = `${recoveryLabel()} · 暂停对轴`;
    ui.syncBadge.classList.remove('good');
    if (snapshot.playing) setProgrammaticPlay();
    else setProgrammaticPause();
    return;
  }

  let decision = syncReconciler.decide({
    drift,
    desiredRate,
    playing: snapshot.playing,
    buffering: state.buffering,
    sampled,
    force,
    reason: snapshot.reason,
  });

  // QoE-first: speeding up a client with almost no buffered media is likely to
  // create a visible stall. Keep normal speed and wait for buffer instead.
  if (decision.action === 'rate' && decision.rate > desiredRate) {
    const bufferedAhead = Number(player.getBufferedAhead?.());
    if (Number.isFinite(bufferedAhead) && bufferedAhead < 3) {
      syncReconciler.stopCorrection?.({ cooldown: true });
      setProgrammaticRate(desiredRate);
      decision = { ...decision, action: 'observe', reason: 'buffer-first' };
    }
  }

  if (decision.action === 'seek') {
    setProgrammaticRate(desiredRate);
    if (absDrift > 0.2) setProgrammaticSeek(target);
  } else if (decision.action === 'rate') {
    setProgrammaticRate(decision.rate);
  } else if (decision.action === 'normal' || decision.action === 'hold') {
    setProgrammaticRate(desiredRate);
  }

  ui.rateSelect.value = String(desiredRate);
  const engine = player.mode === 'libmedia' ? ' · 兼容' : '';
  if (state.seeking || player.seeking) ui.syncBadge.textContent = `正在跳转${engine}`;
  else if (state.buffering) ui.syncBadge.textContent = `缓冲中${engine} · 差 ${absDrift.toFixed(1)}s`;
  else if (decision.reason === 'buffer-first') ui.syncBadge.textContent = `缓存优先${engine} · 暂不加速`;
  else if (decision.reason === 'runaway') ui.syncBadge.textContent = `异常漂移${engine} · 已重新对轴`;
  else if (absDrift <= 0.75) ui.syncBadge.textContent = `观感同步${engine}`;
  else if (absDrift < 1.5 && decision.action !== 'rate') ui.syncBadge.textContent = `观感优先${engine} · 差 ${absDrift.toFixed(1)}s`;
  else if (decision.action === 'rate' || decision.action === 'preserve') ui.syncBadge.textContent = `轻微校准${engine} · 差 ${absDrift.toFixed(1)}s`;
  else if (decision.action === 'seek') ui.syncBadge.textContent = `已重新对轴${engine}`;
  else ui.syncBadge.textContent = `观察偏差${engine} · ${absDrift.toFixed(1)}s`;
  ui.syncBadge.classList.toggle('good', absDrift <= 0.75 && !state.buffering && !state.seeking);

  if (snapshot.playing) setProgrammaticPlay();
  else setProgrammaticPause();
}

function refreshActiveLibraryItem() {
  for (const item of document.querySelectorAll('.library-item')) item.classList.remove('active');
  for (const strong of document.querySelectorAll('.library-item strong')) {
    if (strong.textContent === ui.mediaTitle.textContent) strong.closest('.library-item')?.classList.add('active');
  }
}

function clearRecoveryTimers() {
  clearTimeout(state.recoveryCheckTimer);
  clearTimeout(state.recoveryReloadTimer);
  clearTimeout(state.stallGraceTimer);
  state.recoveryCheckTimer = null;
  state.recoveryReloadTimer = null;
  state.stallGraceTimer = null;
}

function setBuffering(value, options = {}) {
  const next = Boolean(value);
  const resync = options.resync !== false;
  if (state.buffering === next) return;
  state.buffering = next;
  syncReconciler.setBuffering(next);
  if (next) clearCorrection(true);
  ui.selfBuffering.textContent = localMediaStatus();
  if (state.socket?.connected) state.socket.emit('presence:buffering', { buffering: next });
  if (!next && resync) requestSync(false);
}

function scheduleRecoveryCheck() {
  clearTimeout(state.recoveryCheckTimer);
  const tick = () => {
    state.recoveryCheckTimer = null;
    const status = mediaRecovery.stallStatus();
    if (!['stalled', 'recovering'].includes(status.phase)) return;
    if (status.shouldShareBuffering) setBuffering(true);
    if (status.shouldReload) {
      scheduleMediaReload('stall');
      return;
    }
    state.recoveryCheckTimer = setTimeout(tick, 300);
  };
  state.recoveryCheckTimer = setTimeout(tick, 300);
}

function beginMediaStall() {
  if (!state.mediaPath || state.sourceLoading || player.paused || player.seeking || state.seeking) return;

  // Native players often emit waiting/stalled while a Range seek is still being
  // resolved. That is an expected consequence of seeking, not a reason to pause
  // the other viewer. Re-check only after the seek/startup grace expires.
  const remainingGrace = state.seekGraceUntil - Date.now();
  if (remainingGrace > 0) {
    clearTimeout(state.stallGraceTimer);
    state.stallGraceTimer = setTimeout(() => {
      state.stallGraceTimer = null;
      if (!state.mediaPath || state.sourceLoading || player.paused || player.seeking || state.seeking) return;
      if (player.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) beginMediaStall();
    }, remainingGrace + 60);
    return;
  }

  const started = mediaRecovery.beginStall({ position: player.currentTime });
  if (started.ignored) return;
  clearCorrection(true);
  ui.syncBadge.textContent = '检测到媒体卡顿';
  ui.syncBadge.classList.remove('good');
  scheduleRecoveryCheck();
}

function markMediaPlayable() {
  if (!state.mediaPath || !player.hasRenderedFrame) return;
  const result = mediaRecovery.markPlayable();
  if (result.clearSharedBuffering && state.buffering && player.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) {
    setBuffering(false);
    setNotice('媒体重新可播放，连续稳定播放后再恢复自动对轴。');
  }
}

function handleMediaProgress() {
  if (!state.mediaPath || !player.hasRenderedFrame) return;
  const result = mediaRecovery.noteProgress({
    position: player.currentTime,
    readyState: player.readyState,
    paused: player.paused,
    seeking: player.seeking || state.seeking,
  });
  if (result.recovered) {
    clearRecoveryTimers();
    setBuffering(false);
    clearCorrection(false);
    setNotice(player.mode === 'libmedia'
      ? '兼容播放器已稳定播放；已恢复自动对轴。'
      : '播放已稳定；已恢复自动对轴。');
    requestSync(true);
  }
}

function scheduleMediaReload(reason = 'network') {
  if (!state.mediaPath || state.recoveryReloadTimer) return;
  const retry = mediaRecovery.nextRetry();
  if (!retry) {
    clearRecoveryTimers();
    setBuffering(false);
    setNotice('媒体连接多次恢复失败，已停止自动重载，避免无限循环。可以重新选片或刷新页面后再试。', true);
    ui.syncBadge.textContent = '媒体恢复失败';
    return;
  }
  setBuffering(true);
  setNotice(`媒体连接异常，${(retry.delayMs / 1000).toFixed(1)} 秒后进行第 ${retry.attempt}/${retry.maxAttempts} 次恢复…`);
  state.recoveryReloadTimer = setTimeout(() => {
    state.recoveryReloadTimer = null;
    reloadCurrentMedia(reason);
  }, retry.delayMs);
}

function reloadCurrentMedia(reason = 'network') {
  if (!state.mediaPath) return;
  const target = state.lastSnapshot ? targetPosition(state.lastSnapshot) : Number(player.currentTime || 0);
  const seq = ++state.loadSeq;
  state.sourceLoading = true;
  state.mediaReady = false;
  clearCorrection(false);
  mediaRecovery.markReloadStarted(Date.now(), target);
  ui.syncBadge.textContent = '正在恢复媒体';
  setNotice(`正在重新建立 123 媒体读取连接（${reason === 'stall' ? '持续卡顿' : '网络错误'}）…`);

  player.pause();
  player.removeAttribute('src');
  player.src = `/api/media?path=${encodeURIComponent(state.mediaPath)}&v=${state.mediaVersion}&recover=${Date.now()}`;
  player.load();

  const onMetadata = () => {
    player.removeEventListener('loadedmetadata', onMetadata);
    if (seq !== state.loadSeq) return;
    state.sourceLoading = false;
    state.mediaReady = true;
    mediaRecovery.markReloadMetadata();
    if (Number.isFinite(target) && target > 0.05) setProgrammaticSeek(target);
    requestSync(false);
    scheduleRecoveryCheck();
  };
  player.addEventListener('loadedmetadata', onMetadata);
}

player.addEventListener('fallbackstart', () => {
  if (!state.mediaPath) return;
  ui.syncBadge.textContent = '切换兼容模式';
  ui.syncBadge.classList.remove('good');
  setNotice('原生播放器无法解码，正在启动非 Safari 兼容播放器…');
});

player.addEventListener('fallbackready', () => {
  if (!state.mediaPath) return;
  ui.syncBadge.textContent = '兼容模式已解析';
  setNotice('兼容播放器已完成解析，等待首帧。');
});

player.addEventListener('fallbackunavailable', () => {
  state.fallbackUnavailable = true;
});

player.addEventListener('firstrender', () => {
  if (!state.mediaPath) return;
  mediaRecovery.markRendered(player.currentTime);
  armSeekGrace(FIRST_FRAME_GRACE_MS);
  ui.selfBuffering.textContent = localMediaStatus();
  if (player.mode === 'libmedia') setNotice('兼容播放器已输出首帧。');
  else setNotice('视频首帧已就绪。');

  // The metadata-stage catch-up already placed a late joiner near the room
  // timeline. A first frame is proof that playback started, not a request for a
  // second disruptive hard seek.
  requestSync(false);
});

player.addEventListener('play', () => {
  if (state.sourceLoading) return;
  if (state.expectedPlay) {
    state.expectedPlay = false;
    return;
  }
  emitControl('player:play', mediaPayload({ position: player.currentTime }));
});

player.addEventListener('pause', () => {
  if (state.sourceLoading) return;
  if (state.expectedPause) {
    state.expectedPause = false;
    return;
  }
  if (state.seeking || player.seeking) return;
  if (player.ended || !state.mediaPath) return;
  clearRecoveryTimers();
  mediaRecovery.cancelStall({ keepAttempts: true });
  setBuffering(false);
  emitControl('player:pause', mediaPayload({ position: player.currentTime }));
});

player.addEventListener('seeking', () => {
  state.seeking = true;
  mediaRecovery.invalidateStability();

  const expected = state.expectedSeek;
  const current = Number(player.currentTime || 0);
  if (expected && Math.abs(current - expected.target) <= PROGRAMMATIC_SEEK_TOLERANCE) {
    state.seekOrigin = 'programmatic';
  } else {
    // A real user scrub supersedes any old programmatic seek transaction.
    state.expectedSeek = null;
    state.seekOrigin = 'user';
    clearTimeout(state.userSeekCommitTimer);
    state.userSeekCommitTimer = null;
  }

  armSeekGrace(SEEK_GRACE_MS);
  ui.selfBuffering.textContent = localMediaStatus();
  ui.syncBadge.textContent = '正在跳转';
  ui.syncBadge.classList.remove('good');
});

function commitUserSeek() {
  state.userSeekCommitTimer = null;
  if (state.sourceLoading || !state.mediaPath) return;
  if (state.seeking || player.seeking) {
    state.userSeekCommitTimer = setTimeout(commitUserSeek, SEEK_COMMIT_DELAY_MS);
    return;
  }
  clearCorrection(false);
  emitControl('player:seek', mediaPayload({ position: player.currentTime }));
}

player.addEventListener('seeked', () => {
  state.seeking = false;
  ui.selfBuffering.textContent = localMediaStatus();
  if (state.sourceLoading || !state.mediaPath) return;

  const expected = state.expectedSeek;
  const current = Number(player.currentTime || 0);
  if (expected && Math.abs(current - expected.target) <= PROGRAMMATIC_SEEK_TOLERANCE) {
    // No short timeout: remote 4K Range seeks can legitimately take several
    // seconds. Treat the completed seek as local implementation detail forever
    // unless the user explicitly moved to a different target in the meantime.
    state.expectedSeek = null;
    state.seekOrigin = '';
    return;
  }

  state.expectedSeek = null;
  state.seekOrigin = 'user';
  clearTimeout(state.userSeekCommitTimer);
  state.userSeekCommitTimer = setTimeout(commitUserSeek, SEEK_COMMIT_DELAY_MS);
});

player.addEventListener('ratechange', () => {
  if (state.sourceLoading || !state.mediaPath) return;
  const currentRate = Number(player.playbackRate || 1);
  const expected = state.expectedRate;

  // Programmatic sync rates are local implementation details. Never publish them
  // as a room rate, even if Safari delays ratechange for several seconds.
  if (expected && Math.abs(currentRate - expected.value) < 0.01) {
    state.expectedRate = null;
    return;
  }
  state.expectedRate = null;
  if (!isUserPlaybackRate(currentRate)) return;

  clearCorrection(false);
  emitControl('player:rate', mediaPayload({ rate: currentRate }));
});

player.addEventListener('ended', () => {
  clearRecoveryTimers();
  clearTimeout(state.userSeekCommitTimer);
  state.userSeekCommitTimer = null;
  mediaRecovery.cancelStall({ keepAttempts: false });
  setBuffering(false);
  if (state.mediaPath) emitControl('player:pause', mediaPayload({ position: player.duration || player.currentTime }));
});

player.addEventListener('waiting', beginMediaStall);
player.addEventListener('stalled', beginMediaStall);
player.addEventListener('playing', markMediaPlayable);
player.addEventListener('canplay', markMediaPlayable);
player.addEventListener('loadeddata', markMediaPlayable);
player.addEventListener('progress', () => {
  if (state.buffering && player.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) markMediaPlayable();
});
player.addEventListener('timeupdate', handleMediaProgress);

player.addEventListener('error', () => {
  if (!state.mediaPath) return;
  const code = player.error?.code;
  if (code === MediaError.MEDIA_ERR_NETWORK) {
    state.sourceLoading = false;
    state.mediaReady = false;
    mediaRecovery.beginStall({ position: player.currentTime });
    scheduleMediaReload('network');
    return;
  }

  clearRecoveryTimers();
  setBuffering(false);
  state.sourceLoading = false;
  state.mediaReady = false;
  const safariMessage = state.fallbackUnavailable
    ? 'Safari 原生媒体管线无法播放该文件。3.0 已禁用会黑屏/无声的 libmedia Safari fallback；请查看媒体诊断确认 HEVC 封装/Codec。'
    : '';
  const message = safariMessage || (player.mode === 'libmedia'
    ? `原生播放器和兼容播放器都无法播放该视频${player.error?.message ? `：${player.error.message}` : '。'}`
    : (code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED
      ? '浏览器无法播放该视频，请查看媒体诊断。'
      : '视频读取或解码失败，请查看媒体诊断。'));
  setNotice(message, true);
  ui.syncBadge.textContent = '播放失败';
  ui.syncBadge.classList.remove('good');
});

ui.resumeOverlay.addEventListener('click', () => {
  // This click only unlocks/resumes the local browser. The room is already in a
  // playing state, so never publish it as a new authoritative play command.
  state.expectedPlay = true;
  player.play()
    .then(() => ui.resumeOverlay.classList.add('hidden'))
    .catch(() => { state.expectedPlay = false; });
});

ui.waitBtn.addEventListener('click', () => emitControl('player:wait'));
ui.syncNowBtn.addEventListener('click', () => requestSync(true));
ui.rateSelect.addEventListener('change', () => {
  if (!state.mediaPath) return;
  clearCorrection(false);
  state.expectedRate = null;
  player.playbackRate = Number(ui.rateSelect.value || 1);
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
    setSettingsNotice(result.result.message || 'WebDAV 连接成功');
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
    setSettingsNotice('WebDAV 已保存。视频仍由浏览器直接读取 123，服务器不代理视频正文。');
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
