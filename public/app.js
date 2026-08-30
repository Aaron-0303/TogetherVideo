const $ = (id) => document.getElementById(id);

const ui = {
  loginLayer: $('loginLayer'), app: $('app'), loginForm: $('loginForm'), nicknameInput: $('nicknameInput'),
  passwordInput: $('passwordInput'), loginError: $('loginError'), firstRunHint: $('firstRunHint'),
  connectionBadge: $('connectionBadge'), logoutBtn: $('logoutBtn'), settingsBtn: $('settingsBtn'),
  copyRoomBtn: $('copyRoomBtn'), roomCodeText: $('roomCodeText'), members: $('members'), onlineCount: $('onlineCount'),
  libraryList: $('libraryList'), libraryStatus: $('libraryStatus'), breadcrumbs: $('breadcrumbs'),
  refreshLibraryBtn: $('refreshLibraryBtn'), video: $('video'), emptyPlayer: $('emptyPlayer'),
  resumeOverlay: $('resumeOverlay'), mediaTitle: $('mediaTitle'), driftBadge: $('driftBadge'),
  playerNotice: $('playerNotice'), syncNowBtn: $('syncNowBtn'), compatModeBtn: $('compatModeBtn'),
  reactionLayer: $('reactionLayer'), chatMessages: $('chatMessages'), chatForm: $('chatForm'), chatInput: $('chatInput'),
  settingsModal: $('settingsModal'), closeSettingsBtn: $('closeSettingsBtn'), openlistSetupBadge: $('openlistSetupBadge'),
  openlistSetupText: $('openlistSetupText'), quarkSetupBadge: $('quarkSetupBadge'), quarkSetupText: $('quarkSetupText'),
  qrWrap: $('qrWrap'), quarkQr: $('quarkQr'), startQuarkBtn: $('startQuarkBtn'), finishQuarkBtn: $('finishQuarkBtn'),
  resetQuarkBtn: $('resetQuarkBtn'), mediaRootInput: $('mediaRootInput'), saveMediaRootBtn: $('saveMediaRootBtn'),
  newSitePasswordInput: $('newSitePasswordInput'), savePasswordBtn: $('savePasswordBtn'), setupNotice: $('setupNotice'),
};

const state = {
  nickname: '',
  room: '',
  socket: null,
  mediaPath: '',
  mediaName: '',
  mediaVersion: 0,
  libraryPath: '',
  librarySeq: 0,
  hls: null,
  lastServerState: null,
  syncTimer: null,
  setup: null,
  loadSeq: 0,
  sourceLoading: false,
  mediaReady: false,
  buffering: false,
  lastBufferAt: 0,
  lastHardSeekAt: 0,
  forceSyncOnce: false,
  compatMode: localStorage.getItem('together_play_mode') === 'compat',
  expectedSeq: 0,
  expected: { play: [], pause: [], seek: [], rate: [] },
  rateCorrectionTimer: null,
  rateCorrectionBase: 1,
  rateCorrectionDirection: 0,
};

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401 && url !== '/api/login') {
    showLogin();
    throw new Error(data.error || '请先登录');
  }
  if (!response.ok || data.ok === false) throw new Error(data.error || `请求失败 (${response.status})`);
  return data;
}

function showLogin() {
  ui.loginLayer.classList.remove('hidden');
  ui.app.classList.add('hidden');
  ui.settingsModal.classList.add('hidden');
}
function showApp() { ui.loginLayer.classList.add('hidden'); ui.app.classList.remove('hidden'); }
function setNotice(text = '') { ui.playerNotice.textContent = text; }
function setSetupNotice(text = '', error = false) {
  ui.setupNotice.textContent = text;
  ui.setupNotice.classList.toggle('error-text', Boolean(error));
}
function formatBytes(bytes) {
  if (!bytes) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i > 1 ? 1 : 0)} ${units[i]}`;
}
function formatTime(ts) { return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
function encodePath(value) { return encodeURIComponent(value || ''); }
function roomFromUrl() { return new URLSearchParams(location.search).get('room') || ''; }
function normalizeRoom(room) { return String(room || 'ours').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40) || 'ours'; }
function playMode() { return state.compatMode ? 'compat' : 'original'; }
function desiredRoomRate() { return Number(state.lastServerState?.rate || 1); }

function addExpected(type, value = null, ttl = 2000) {
  const token = { id: ++state.expectedSeq, value, timer: null };
  state.expected[type].push(token);
  token.timer = setTimeout(() => removeExpected(type, token), ttl);
  return token;
}

function removeExpected(type, token) {
  const list = state.expected[type];
  const index = list.indexOf(token);
  if (index >= 0) list.splice(index, 1);
  if (token?.timer) clearTimeout(token.timer);
}

function consumeExpected(type, value = null, tolerance = 0.1) {
  const list = state.expected[type];
  let index = -1;
  if (value == null) index = list.length ? 0 : -1;
  else index = list.findIndex((token) => token.value != null && Math.abs(Number(token.value) - Number(value)) <= tolerance);
  if (index < 0) return false;
  const [token] = list.splice(index, 1);
  if (token.timer) clearTimeout(token.timer);
  return true;
}

function clearExpectedEvents() {
  for (const type of Object.keys(state.expected)) {
    for (const token of state.expected[type]) if (token.timer) clearTimeout(token.timer);
    state.expected[type] = [];
  }
}

function mediaPayload(extra = {}) {
  return {
    mediaPath: state.mediaPath,
    mediaVersion: state.mediaVersion,
    ...extra,
  };
}

async function programmaticPlay() {
  if (!state.mediaReady || !ui.video.paused) return true;
  const token = addExpected('play');
  try {
    await ui.video.play();
    ui.resumeOverlay.classList.add('hidden');
    return true;
  } catch {
    removeExpected('play', token);
    ui.resumeOverlay.classList.remove('hidden');
    return false;
  }
}

function programmaticPause() {
  if (ui.video.paused) return;
  addExpected('pause');
  ui.video.pause();
}

function programmaticSeek(target) {
  if (!state.mediaReady || ui.video.readyState < HTMLMediaElement.HAVE_METADATA) return false;
  let value = Math.max(0, Number(target || 0));
  if (Number.isFinite(ui.video.duration) && ui.video.duration > 0) value = Math.min(value, Math.max(0, ui.video.duration - 0.05));
  if (Math.abs((ui.video.currentTime || 0) - value) < 0.05) return false;
  addExpected('seek', value, 3000);
  try {
    ui.video.currentTime = value;
    return true;
  } catch {
    consumeExpected('seek', value, 0.5);
    return false;
  }
}

function programmaticRate(rate) {
  const value = Math.min(4, Math.max(0.25, Number(rate || 1)));
  if (Math.abs(ui.video.playbackRate - value) < 0.005) return;
  addExpected('rate', value, 1500);
  ui.video.playbackRate = value;
}

function cancelRateCorrection(restoreRate = null) {
  if (state.rateCorrectionTimer) clearTimeout(state.rateCorrectionTimer);
  state.rateCorrectionTimer = null;
  state.rateCorrectionDirection = 0;
  if (restoreRate != null && state.mediaReady) programmaticRate(restoreRate);
}

function startRateCorrection(baseRate, direction, drift) {
  if (state.rateCorrectionTimer && state.rateCorrectionDirection === direction && Math.abs(state.rateCorrectionBase - baseRate) < 0.005) return;
  cancelRateCorrection();
  state.rateCorrectionBase = baseRate;
  state.rateCorrectionDirection = direction;
  const delta = Math.min(0.08, Math.max(0.03, Number(drift || 0) * 0.015));
  const corrected = Math.min(4, Math.max(0.25, baseRate + direction * delta));
  programmaticRate(corrected);
  state.rateCorrectionTimer = setTimeout(() => {
    state.rateCorrectionTimer = null;
    state.rateCorrectionDirection = 0;
    if (state.mediaReady) programmaticRate(state.rateCorrectionBase);
  }, 3000);
}

function updatePlayModeUI() {
  if (!ui.compatModeBtn) return;
  ui.compatModeBtn.textContent = state.compatMode ? '兼容播放：开' : '原画直链';
  ui.compatModeBtn.classList.toggle('active-mode', state.compatMode);
  ui.compatModeBtn.title = state.compatMode
    ? '当前设备使用夸克转码兼容流。只影响这台设备。点击恢复原画直链。'
    : '默认使用夸克原文件直链。若本设备黑屏或无法解码，可点击切换兼容播放。';
}

async function bootstrap() {
  updatePlayModeUI();
  const session = await api('/api/session').catch(() => ({ authenticated: false, passwordChanged: true }));
  ui.firstRunHint.classList.toggle('hidden', session.passwordChanged !== false);
  if (!session.authenticated) return showLogin();
  state.nickname = session.nickname;
  state.room = roomFromUrl() || localStorage.getItem('together_room') || session.defaultRoom || 'ours';
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
    state.room = normalizeRoom(roomFromUrl() || localStorage.getItem('together_room') || result.defaultRoom);
    ui.firstRunHint.classList.toggle('hidden', result.passwordChanged !== false);
    startApp();
  } catch (error) { ui.loginError.textContent = error.message; }
});

ui.logoutBtn.addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' }).catch(() => {});
  state.socket?.disconnect();
  showLogin();
});

ui.copyRoomBtn.addEventListener('click', async () => {
  try {
    const url = new URL(location.href);
    url.searchParams.set('room', state.room);
    await navigator.clipboard.writeText(url.toString());
    ui.copyRoomBtn.textContent = '已复制';
    setTimeout(() => { ui.copyRoomBtn.textContent = '复制房间链接'; }, 1200);
  } catch { setNotice('复制失败，请手动复制当前网址。'); }
});

ui.refreshLibraryBtn.addEventListener('click', () => loadLibrary(state.libraryPath));
ui.syncNowBtn.addEventListener('click', () => {
  state.forceSyncOnce = true;
  state.socket?.emit('sync:request');
});
ui.compatModeBtn?.addEventListener('click', async () => {
  state.compatMode = !state.compatMode;
  localStorage.setItem('together_play_mode', state.compatMode ? 'compat' : 'original');
  updatePlayModeUI();
  if (!state.mediaPath) return;
  setNotice(state.compatMode ? '正在为这台设备切换到兼容播放…' : '正在为这台设备恢复原画直链…');
  await loadMedia(state.mediaPath, state.mediaName, state.mediaVersion);
});

function startApp() {
  showApp();
  state.room = normalizeRoom(state.room);
  localStorage.setItem('together_room', state.room);
  ui.roomCodeText.textContent = state.room;
  const url = new URL(location.href);
  url.searchParams.set('room', state.room);
  history.replaceState(null, '', url);
  updatePlayModeUI();
  connectSocket();
  loadLibrary('');
  loadSetupStatus(true);
}

ui.settingsBtn.addEventListener('click', () => { ui.settingsModal.classList.remove('hidden'); loadSetupStatus(false); });
ui.closeSettingsBtn.addEventListener('click', () => ui.settingsModal.classList.add('hidden'));
ui.settingsModal.addEventListener('click', (event) => { if (event.target === ui.settingsModal) ui.settingsModal.classList.add('hidden'); });

async function loadSetupStatus(autoOpen = false) {
  try {
    const result = await api('/api/setup/status');
    state.setup = result;
    renderSetup(result);
    if (autoOpen && result.firstRun) ui.settingsModal.classList.remove('hidden');
  } catch (error) { if (!autoOpen) setSetupNotice(error.message, true); }
}

function renderSetup(result) {
  const open = result.openlist || {};
  ui.openlistSetupBadge.textContent = open.ready ? '已启动' : '异常';
  ui.openlistSetupBadge.classList.toggle('online', Boolean(open.ready));
  ui.openlistSetupText.textContent = open.ready
    ? (open.adminError || 'OpenList 已由 TogetherVideo 自动启动，无需单独部署。')
    : (open.bootstrapError || 'OpenList 尚未启动。请查看部署日志。');

  const q = result.quark || {};
  ui.quarkSetupBadge.textContent = q.ready ? '已授权' : q.qr ? '等待扫码' : q.exists ? '未完成' : '未配置';
  ui.quarkSetupBadge.classList.toggle('online', Boolean(q.ready));
  ui.quarkSetupText.textContent = q.ready
    ? `QuarkTV 已连接${q.mountPath ? `，挂载在 ${q.mountPath}` : ''}。默认播放使用原画直链。`
    : q.qr ? '二维码已生成，请扫码确认。' : q.exists ? (q.status || '授权尚未完成。') : '尚未添加 QuarkTV。';
  ui.qrWrap.classList.toggle('hidden', !q.qr);
  if (q.qr) ui.quarkQr.src = q.qr; else ui.quarkQr.removeAttribute('src');
  ui.startQuarkBtn.classList.toggle('hidden', q.ready || Boolean(q.qr));
  ui.finishQuarkBtn.classList.toggle('hidden', !q.qr);
  ui.resetQuarkBtn.classList.toggle('hidden', q.ready || !q.exists);
  ui.mediaRootInput.value = result.settings?.mediaRoot || '/QuarkTV';
}

ui.startQuarkBtn.addEventListener('click', async () => {
  setSetupNotice('正在生成夸克登录二维码...');
  ui.startQuarkBtn.disabled = true;
  try {
    await api('/api/setup/quark/start', { method: 'POST' });
    await loadSetupStatus(false);
    setSetupNotice('二维码已生成，请用夸克 App 扫码。');
  } catch (error) { setSetupNotice(error.message, true); }
  finally { ui.startQuarkBtn.disabled = false; }
});

ui.finishQuarkBtn.addEventListener('click', async () => {
  setSetupNotice('正在确认扫码并获取夸克授权...');
  ui.finishQuarkBtn.disabled = true;
  try {
    const result = await api('/api/setup/quark/finish', { method: 'POST' });
    await loadSetupStatus(false);
    if (result.quark?.ready) { setSetupNotice('夸克授权成功，可以读取片库了。'); loadLibrary(''); }
    else setSetupNotice('暂未检测到授权。请确认手机端已同意，或重新生成二维码。', true);
  } catch (error) { setSetupNotice(error.message, true); }
  finally { ui.finishQuarkBtn.disabled = false; }
});

ui.resetQuarkBtn.addEventListener('click', async () => {
  setSetupNotice('正在重新生成二维码...');
  ui.resetQuarkBtn.disabled = true;
  try {
    await api('/api/setup/quark/reset', { method: 'POST' });
    await loadSetupStatus(false);
    setSetupNotice('新二维码已生成。');
  } catch (error) { setSetupNotice(error.message, true); }
  finally { ui.resetQuarkBtn.disabled = false; }
});

ui.saveMediaRootBtn.addEventListener('click', async () => {
  const mediaRoot = ui.mediaRootInput.value.trim() || '/QuarkTV';
  setSetupNotice('正在保存片库目录...');
  try {
    const result = await api('/api/settings', { method: 'POST', body: JSON.stringify({ mediaRoot }) });
    ui.mediaRootInput.value = result.settings.mediaRoot;
    state.libraryPath = '';
    await loadLibrary('');
    setSetupNotice(`片库目录已切换到 ${result.settings.mediaRoot}`);
  } catch (error) { setSetupNotice(error.message, true); }
});

ui.savePasswordBtn.addEventListener('click', async () => {
  const newPassword = ui.newSitePasswordInput.value;
  if (!newPassword) return setSetupNotice('请输入新访问密码。', true);
  try {
    await api('/api/settings', { method: 'POST', body: JSON.stringify({ newPassword }) });
    ui.newSitePasswordInput.value = '';
    ui.firstRunHint.classList.add('hidden');
    setSetupNotice('网站访问密码已修改。');
  } catch (error) { setSetupNotice(error.message, true); }
});

function connectSocket() {
  state.socket?.disconnect();
  const socket = io({ transports: ['websocket', 'polling'] });
  state.socket = socket;
  socket.on('connect', () => {
    ui.connectionBadge.textContent = '已连接';
    ui.connectionBadge.classList.add('online');
    socket.emit('room:join', { room: state.room, nickname: state.nickname }, (result) => {
      if (!result?.ok) setNotice(result?.error || '加入房间失败');
    });
  });
  socket.on('disconnect', () => {
    ui.connectionBadge.textContent = '重连中';
    ui.connectionBadge.classList.remove('online');
  });
  socket.on('connect_error', (error) => {
    ui.connectionBadge.textContent = '连接失败';
    setNotice(error.message);
  });
  socket.on('room:snapshot', (snapshot) => {
    renderMembers(snapshot.members || []);
    renderMessages(snapshot.messages || []);
    applyServerState(snapshot, true);
  });
  socket.on('room:members', renderMembers);
  socket.on('player:state', (snapshot) => applyServerState(snapshot, false));
  socket.on('chat:message', appendMessage);
  socket.on('reaction:show', showReaction);
  clearInterval(state.syncTimer);
  state.syncTimer = setInterval(() => {
    if (socket.connected && state.mediaPath) socket.emit('sync:request');
  }, 5000);
}

function renderMembers(members) {
  ui.members.replaceChildren();
  for (const member of members) {
    const el = document.createElement('span');
    el.className = 'member-pill';
    el.textContent = member.nickname;
    ui.members.appendChild(el);
  }
  ui.onlineCount.textContent = `${members.length} 在线`;
}

async function loadLibrary(relativePath = '') {
  const seq = ++state.librarySeq;
  state.libraryPath = relativePath;
  ui.libraryStatus.textContent = '正在读取片库...';
  ui.libraryList.replaceChildren();
  renderBreadcrumbs(relativePath);
  try {
    const result = await api(`/api/library?path=${encodePath(relativePath)}`);
    if (seq !== state.librarySeq) return;
    ui.libraryStatus.textContent = result.items.length ? `${result.items.length} 项` : '这里还没有可播放内容';
    for (const item of result.items) ui.libraryList.appendChild(renderLibraryItem(item));
  } catch (error) {
    if (seq !== state.librarySeq) return;
    ui.libraryStatus.textContent = error.message;
    if (/OpenList|Quark|storage|挂载|对象/.test(error.message)) loadSetupStatus(false);
  }
}

function renderLibraryItem(item) {
  const button = document.createElement('button');
  button.className = `library-item${item.relativePath === state.mediaPath ? ' active' : ''}`;
  button.dataset.path = item.relativePath;
  const ext = item.isDir ? '' : item.name.split('.').pop()?.toUpperCase();
  button.innerHTML = `<span class="file-icon">${item.isDir ? '▰' : '▶'}</span><span><strong title=""></strong><small></small></span><small>${item.isDir ? '›' : ext || ''}</small>`;
  button.querySelector('strong').textContent = item.name;
  button.querySelector('strong').title = item.name;
  button.querySelector('span small').textContent = item.isDir ? '文件夹' : formatBytes(item.size);
  button.addEventListener('click', () => item.isDir ? loadLibrary(item.relativePath) : selectMedia(item));
  return button;
}

function renderBreadcrumbs(relativePath) {
  ui.breadcrumbs.replaceChildren();
  const parts = relativePath ? relativePath.split('/') : [];
  const crumbs = [{ label: '根目录', path: '' }];
  let current = '';
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    crumbs.push({ label: part, path: current });
  }
  crumbs.forEach((crumb, index) => {
    const button = document.createElement('button');
    button.textContent = `${index ? '/ ' : ''}${crumb.label}`;
    button.addEventListener('click', () => loadLibrary(crumb.path));
    ui.breadcrumbs.appendChild(button);
  });
}

function selectMedia(item) {
  state.socket?.emit('player:media', { mediaPath: item.relativePath, mediaName: item.name });
}

async function loadMedia(mediaPath, mediaName, mediaVersion) {
  if (!mediaPath) return;
  const seq = ++state.loadSeq;
  state.sourceLoading = true;
  state.mediaReady = false;
  state.buffering = false;
  state.mediaPath = mediaPath;
  state.mediaName = mediaName || mediaPath.split('/').pop();
  state.mediaVersion = Number(mediaVersion || 0);
  state.forceSyncOnce = false;
  ui.mediaTitle.textContent = state.mediaName;
  ui.emptyPlayer.classList.add('hidden');
  ui.resumeOverlay.classList.add('hidden');
  setNotice(state.compatMode ? '正在获取夸克兼容播放地址…' : '正在获取夸克原画直链…');
  cancelRateCorrection();
  clearExpectedEvents();

  state.hls?.destroy();
  state.hls = null;
  ui.video.pause();
  ui.video.removeAttribute('src');
  ui.video.load();

  try {
    const info = await api(`/api/play-info?path=${encodePath(mediaPath)}&mode=${playMode()}`);
    if (seq !== state.loadSeq) return;
    const delivery = info.delivery || (info.extension === '.m3u8' ? 'hls' : 'file');

    if (delivery === 'hls') {
      if (window.Hls?.isSupported()) {
        state.hls = new Hls({
          enableWorker: true,
          lowLatencyMode: false,
          backBufferLength: 60,
          maxBufferLength: 30,
          maxMaxBufferLength: 60,
        });
        state.hls.loadSource(info.playUrl);
        state.hls.attachMedia(ui.video);
        state.hls.on(Hls.Events.ERROR, (_event, data) => {
          if (!data.fatal) return;
          state.sourceLoading = false;
          state.mediaReady = false;
          setNotice('兼容流 HLS 加载失败，可能是夸克 CDN 跨域限制。请恢复“原画直链”或更换浏览器。');
        });
      } else if (ui.video.canPlayType('application/vnd.apple.mpegurl')) {
        ui.video.src = info.playUrl;
        ui.video.load();
      } else {
        state.sourceLoading = false;
        setNotice('当前浏览器不支持这个兼容视频流，请恢复“原画直链”或使用 Chrome / Edge / Safari。');
        return;
      }
    } else {
      ui.video.src = info.playUrl;
      ui.video.load();
    }

    if (['.mkv', '.ts'].includes(info.extension) && !state.compatMode) {
      setNotice('该格式可能无法原画播放；若黑屏可切换“兼容播放”。');
    }
    refreshActiveLibraryItem();
  } catch (error) {
    if (seq !== state.loadSeq) return;
    state.sourceLoading = false;
    state.mediaReady = false;
    setNotice(error.message);
  }
}

function refreshActiveLibraryItem() {
  document.querySelectorAll('.library-item').forEach((el) => {
    el.classList.toggle('active', el.dataset.path === state.mediaPath);
  });
}

function applyServerState(snapshot, initial) {
  state.lastServerState = snapshot;
  const incomingVersion = Number(snapshot.mediaVersion || 0);
  const changedMedia = snapshot.mediaPath && (
    snapshot.mediaPath !== state.mediaPath || incomingVersion !== state.mediaVersion
  );

  if (changedMedia) {
    loadMedia(snapshot.mediaPath, snapshot.mediaName, incomingVersion).catch((error) => setNotice(error.message));
    return;
  }
  if (!snapshot.mediaPath || snapshot.mediaPath !== state.mediaPath) return;
  if (state.sourceLoading || !state.mediaReady) return;
  applyPlayback(snapshot, initial);
}

function applyPlayback(snapshot, initial = false) {
  if (!snapshot.mediaPath || snapshot.mediaPath !== state.mediaPath) return;
  if (Number(snapshot.mediaVersion || 0) !== state.mediaVersion) return;
  if (!state.mediaReady || state.sourceLoading || ui.video.readyState < HTMLMediaElement.HAVE_METADATA) return;

  const desiredRate = Math.min(4, Math.max(0.25, Number(snapshot.rate || 1)));
  if (state.rateCorrectionTimer && Math.abs(state.rateCorrectionBase - desiredRate) > 0.005) {
    cancelRateCorrection(desiredRate);
  } else if (!state.rateCorrectionTimer && Math.abs(ui.video.playbackRate - desiredRate) > 0.01) {
    programmaticRate(desiredRate);
  }

  let target = Math.max(0, Number(snapshot.position || 0));
  if (Number.isFinite(ui.video.duration) && ui.video.duration > 0) {
    target = Math.min(target, Math.max(0, ui.video.duration - 0.05));
  }
  const drift = Math.abs((ui.video.currentTime || 0) - target);
  ui.driftBadge.textContent = drift < 0.35 ? '已同步' : `偏差 ${drift.toFixed(1)}s`;

  const now = Date.now();
  const recentlyBuffered = now - state.lastBufferAt < 8000;
  const canSoftCorrect = !state.buffering && !ui.video.seeking && ui.video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA;
  const canHardCorrect = !state.buffering && !ui.video.seeking && ui.video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA;
  const forceHard = state.forceSyncOnce;

  if (initial || forceHard) {
    state.forceSyncOnce = false;
    cancelRateCorrection(desiredRate);
    if (drift > 0.2 && programmaticSeek(target)) state.lastHardSeekAt = now;
  } else if (drift > 3 && canHardCorrect && !recentlyBuffered && now - state.lastHardSeekAt > 5000) {
    cancelRateCorrection(desiredRate);
    if (programmaticSeek(target)) state.lastHardSeekAt = now;
  } else if (drift > 0.45 && snapshot.playing && canSoftCorrect) {
    const direction = ui.video.currentTime < target ? 1 : -1;
    startRateCorrection(desiredRate, direction, drift);
  } else if (drift < 0.25 && state.rateCorrectionTimer) {
    cancelRateCorrection(desiredRate);
  }

  if (snapshot.playing) {
    if (ui.video.paused) programmaticPlay();
  } else {
    cancelRateCorrection(desiredRate);
    if (!ui.video.paused) programmaticPause();
  }
}

ui.resumeOverlay.addEventListener('click', () => {
  ui.resumeOverlay.classList.add('hidden');
  programmaticPlay();
});

ui.video.addEventListener('play', () => {
  if (state.sourceLoading || !state.mediaReady) return;
  if (consumeExpected('play')) return;
  if (state.lastServerState?.playing) {
    state.socket?.emit('sync:request');
    return;
  }
  state.lastServerState = { ...(state.lastServerState || {}), playing: true, position: ui.video.currentTime };
  state.socket?.emit('player:play', mediaPayload({ position: ui.video.currentTime }));
});

ui.video.addEventListener('pause', () => {
  if (state.sourceLoading || !state.mediaReady) return;
  if (consumeExpected('pause')) return;
  if (ui.video.ended || document.hidden) return;
  if (state.lastServerState && !state.lastServerState.playing) return;
  state.lastServerState = { ...(state.lastServerState || {}), playing: false, position: ui.video.currentTime };
  state.socket?.emit('player:pause', mediaPayload({ position: ui.video.currentTime }));
});

ui.video.addEventListener('seeked', () => {
  if (state.sourceLoading || !state.mediaReady) return;
  if (consumeExpected('seek', ui.video.currentTime, 0.4)) return;
  cancelRateCorrection(desiredRoomRate());
  state.socket?.emit('player:seek', mediaPayload({ position: ui.video.currentTime }));
});

ui.video.addEventListener('ratechange', () => {
  if (state.sourceLoading || !state.mediaReady) return;
  if (consumeExpected('rate', ui.video.playbackRate, 0.02)) return;
  if (state.rateCorrectionTimer) {
    clearTimeout(state.rateCorrectionTimer);
    state.rateCorrectionTimer = null;
    state.rateCorrectionDirection = 0;
  }
  state.socket?.emit('player:rate', mediaPayload({ rate: ui.video.playbackRate }));
});

ui.video.addEventListener('loadedmetadata', () => {
  if (!state.mediaPath) return;
  state.sourceLoading = false;
  state.mediaReady = true;
  state.buffering = false;
  if (/正在获取夸克/.test(ui.playerNotice.textContent)) setNotice('');
  if (state.lastServerState) applyPlayback(state.lastServerState, true);
  state.socket?.emit('sync:request');
});

ui.video.addEventListener('canplay', () => {
  const recovered = state.buffering;
  state.sourceLoading = false;
  state.mediaReady = true;
  state.buffering = false;
  if (/缓冲|网络停滞|正在获取夸克/.test(ui.playerNotice.textContent)) setNotice('');
  if (recovered) {
    state.socket?.emit('sync:request');
    if (state.lastServerState) applyPlayback(state.lastServerState, false);
  }
});

ui.video.addEventListener('playing', () => {
  state.buffering = false;
  if (/缓冲|网络停滞/.test(ui.playerNotice.textContent)) setNotice('');
});

ui.video.addEventListener('waiting', () => {
  if (!state.mediaPath || state.sourceLoading) return;
  state.buffering = true;
  state.lastBufferAt = Date.now();
  cancelRateCorrection(desiredRoomRate());
  setNotice(state.compatMode ? '兼容流正在缓冲…不会反复跳进度，等待夸克 CDN 恢复。' : '原画正在缓冲…不会反复跳进度，等待夸克 CDN 恢复。');
});

ui.video.addEventListener('stalled', () => {
  if (!state.mediaPath || state.sourceLoading) return;
  state.buffering = true;
  state.lastBufferAt = Date.now();
  cancelRateCorrection(desiredRoomRate());
  setNotice(state.compatMode ? '兼容流网络停滞，正在等待夸克 CDN…' : '原画直链网络停滞，正在等待夸克 CDN…');
});

ui.video.addEventListener('ended', () => {
  if (!state.mediaPath || !state.mediaReady) return;
  cancelRateCorrection();
  const position = Number.isFinite(ui.video.duration) ? ui.video.duration : ui.video.currentTime;
  state.lastServerState = { ...(state.lastServerState || {}), playing: false, position };
  state.socket?.emit('player:pause', mediaPayload({ position, reason: 'ended' }));
});

ui.video.addEventListener('error', () => {
  if (!state.mediaPath) return;
  state.sourceLoading = false;
  state.mediaReady = false;
  state.buffering = false;
  cancelRateCorrection();
  setNotice(state.compatMode
    ? '这台设备的兼容流也无法播放。请尝试恢复原画，或更换 Chrome / Edge / Safari。'
    : '这台设备无法播放原画。MP4 也可能是 HEVC/H.265 编码；请切换“兼容播放”。');
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    cancelRateCorrection(desiredRoomRate());
    return;
  }
  if (state.socket?.connected && state.mediaPath) state.socket.emit('sync:request');
});

function renderMessages(messages) {
  ui.chatMessages.replaceChildren();
  messages.forEach(appendMessage);
}

function appendMessage(message) {
  const wrap = document.createElement('div');
  wrap.className = 'message';
  const meta = document.createElement('div');
  meta.className = 'message-meta';
  meta.textContent = `${message.nickname} · ${formatTime(message.at)}`;
  const body = document.createElement('div');
  body.className = 'message-body';
  body.textContent = message.text;
  wrap.append(meta, body);
  ui.chatMessages.appendChild(wrap);
  ui.chatMessages.scrollTop = ui.chatMessages.scrollHeight;
}

ui.chatForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const text = ui.chatInput.value.trim();
  if (!text) return;
  state.socket?.emit('chat:send', { text }, (result) => { if (result?.ok) ui.chatInput.value = ''; });
});

document.querySelectorAll('[data-reaction]').forEach((button) => {
  button.addEventListener('click', () => state.socket?.emit('reaction:send', { emoji: button.dataset.reaction }));
});

function showReaction(payload) {
  const el = document.createElement('div');
  el.className = 'floating-reaction';
  el.textContent = payload.emoji;
  el.style.left = `${10 + Math.random() * 75}%`;
  ui.reactionLayer.appendChild(el);
  setTimeout(() => el.remove(), 2600);
}

bootstrap();