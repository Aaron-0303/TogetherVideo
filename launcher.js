const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const tar = require('tar');

const root = process.cwd();
const runtimeDir = path.join(root, '.runtime', 'openlist');
const archivePath = path.join(runtimeDir, 'openlist.tar.gz');
const binaryPath = path.join(runtimeDir, process.platform === 'win32' ? 'openlist.exe' : 'openlist');
const configPath = path.join(runtimeDir, 'data', 'config.json');
const adminSecretPath = path.join(runtimeDir, '.admin-secret');
const adminReadyPath = path.join(runtimeDir, '.admin-ready');
const baseUrl = process.env.OPENLIST_BASE_URL || 'http://127.0.0.1:5244';
const managedOpenList = String(process.env.OPENLIST_MANAGED || 'true').toLowerCase() !== 'false';
const openListVersion = process.env.OPENLIST_VERSION || 'v4.2.5';
let openlistProcess = null;
let appProcess = null;
let intentionallyStoppingOpenList = false;
let shuttingDown = false;
let restartTimer = null;

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function isOpenListReady() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    const response = await fetch(`${baseUrl}/api/public/settings`, { signal: controller.signal });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function assetName() {
  if (process.platform !== 'linux') {
    throw new Error('自动 OpenList 当前只支持 Linux 服务器；其他系统请设置 OPENLIST_MANAGED=false 并提供外部 OpenList。');
  }
  if (process.arch === 'x64') return 'openlist-linux-amd64.tar.gz';
  if (process.arch === 'arm64') return 'openlist-linux-arm64.tar.gz';
  throw new Error(`暂不支持自动安装 OpenList 的架构: ${process.arch}`);
}

async function download(url, target) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120000);
  try {
    const response = await fetch(url, { redirect: 'follow', signal: controller.signal });
    if (!response.ok || !response.body) throw new Error(`下载 OpenList 失败: HTTP ${response.status}`);
    const file = fs.createWriteStream(target);
    await new Promise((resolve, reject) => {
      const reader = response.body.getReader();
      const pump = async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!file.write(Buffer.from(value))) await new Promise((resume) => file.once('drain', resume));
          }
          file.end(resolve);
        } catch (error) {
          file.destroy();
          reject(error);
        }
      };
      pump();
    });
  } finally {
    clearTimeout(timer);
  }
}

async function ensureBinary() {
  await fsp.mkdir(runtimeDir, { recursive: true });
  try {
    await fsp.access(binaryPath, fs.constants.X_OK);
    return;
  } catch {}
  const asset = assetName();
  const url = `https://github.com/OpenListTeam/OpenList/releases/download/${openListVersion}/${asset}`;
  console.log(`[bootstrap] downloading OpenList ${openListVersion}: ${asset}`);
  await download(url, archivePath);
  await tar.x({ file: archivePath, cwd: runtimeDir });
  await fsp.chmod(binaryPath, 0o755);
  await fsp.rm(archivePath, { force: true });
  console.log(`[bootstrap] OpenList ${openListVersion} binary ready`);
}

async function forceLoopbackConfig() {
  try {
    const cfg = JSON.parse(await fsp.readFile(configPath, 'utf8'));
    cfg.scheme = cfg.scheme || {};
    cfg.scheme.address = '127.0.0.1';
    cfg.scheme.http_port = 5244;
    await fsp.writeFile(configPath, `${JSON.stringify(cfg, null, 2)}\n`);
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn('[bootstrap] unable to force OpenList loopback config:', error.message);
  }
}

function scheduleOpenListRestart() {
  if (!managedOpenList || shuttingDown || intentionallyStoppingOpenList || restartTimer) return;
  restartTimer = setTimeout(async () => {
    restartTimer = null;
    if (shuttingDown || intentionallyStoppingOpenList || await isOpenListReady()) return;
    try {
      console.warn('[bootstrap] restarting OpenList after unexpected exit');
      spawnOpenList();
    } catch (error) {
      console.error('[bootstrap] OpenList restart failed:', error.message);
      scheduleOpenListRestart();
    }
  }, 2500);
  restartTimer.unref?.();
}

function spawnOpenList() {
  const child = spawn(binaryPath, ['server', '--force-bin-dir', '--log-std'], {
    cwd: runtimeDir,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => process.stdout.write(`[openlist] ${chunk}`));
  child.stderr.on('data', (chunk) => process.stderr.write(`[openlist] ${chunk}`));
  child.on('exit', (code, signal) => {
    console.warn(`[bootstrap] OpenList exited code=${code} signal=${signal || ''}`);
    if (openlistProcess === child) openlistProcess = null;
    scheduleOpenListRestart();
  });
  openlistProcess = child;
  return child;
}

async function waitForOpenList(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isOpenListReady()) return true;
    if (openlistProcess && openlistProcess.exitCode != null) return false;
    await sleep(500);
  }
  return false;
}

async function stopOpenList() {
  const child = openlistProcess;
  if (!child || child.exitCode != null) return;
  intentionallyStoppingOpenList = true;
  try {
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (child.exitCode == null) child.kill('SIGKILL');
        resolve();
      }, 5000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill('SIGTERM');
    });
    openlistProcess = null;
    await sleep(250);
  } finally {
    intentionallyStoppingOpenList = false;
  }
}

async function ensureAdminSecret() {
  try { return (await fsp.readFile(adminSecretPath, 'utf8')).trim(); } catch {}
  const secret = crypto.randomBytes(24).toString('base64url');
  await fsp.writeFile(adminSecretPath, `${secret}\n`, { mode: 0o600 });
  return secret;
}

function setAdminPassword(secret) {
  const result = spawnSync(binaryPath, ['admin', 'set', secret, '--force-bin-dir'], {
    cwd: runtimeDir,
    encoding: 'utf8',
    timeout: 15000,
  });
  if (result.status !== 0) {
    throw new Error(`设置 OpenList 内部管理员密码失败: ${(result.stderr || result.stdout || '').trim()}`);
  }
}

async function startManagedOpenList() {
  if (!managedOpenList) return null;
  if (await isOpenListReady()) {
    console.log('[bootstrap] using existing OpenList at', baseUrl);
    return null;
  }
  await ensureBinary();
  const secret = await ensureAdminSecret();
  let adminReady = false;
  try {
    await fsp.access(adminReadyPath);
    adminReady = true;
  } catch {}

  if (adminReady) {
    await forceLoopbackConfig();
    spawnOpenList();
    if (!(await waitForOpenList())) throw new Error('OpenList 启动失败或 30 秒内未就绪');
  } else {
    // First launch creates OpenList's database and config. It is restarted immediately
    // with a loopback-only HTTP listener and a private internal admin password.
    spawnOpenList();
    if (!(await waitForOpenList())) throw new Error('OpenList 首次初始化失败或 30 秒内未就绪');
    console.log('[bootstrap] initializing private OpenList admin credentials');
    await stopOpenList();
    await forceLoopbackConfig();
    setAdminPassword(secret);
    await fsp.writeFile(adminReadyPath, 'ok\n');
    spawnOpenList();
    if (!(await waitForOpenList())) throw new Error('OpenList 初始化管理员后重新启动失败');
  }

  process.env.OPENLIST_ADMIN_PASSWORD = secret;
  return secret;
}

function startApp() {
  appProcess = spawn(process.execPath, ['server.js'], { cwd: root, env: process.env, stdio: 'inherit' });
  appProcess.on('exit', (code, signal) => {
    shuttingDown = true;
    if (restartTimer) clearTimeout(restartTimer);
    if (openlistProcess && openlistProcess.exitCode == null) openlistProcess.kill('SIGTERM');
    process.exitCode = code ?? (signal ? 1 : 0);
  });
}

function shutdown(signal) {
  shuttingDown = true;
  if (restartTimer) clearTimeout(restartTimer);
  if (appProcess && appProcess.exitCode == null) appProcess.kill(signal);
  if (openlistProcess && openlistProcess.exitCode == null) openlistProcess.kill(signal);
  setTimeout(() => process.exit(0), 1500).unref();
}

(async () => {
  try {
    process.env.OPENLIST_BASE_URL = baseUrl;
    const secret = await startManagedOpenList();
    if (!secret && !process.env.OPENLIST_ADMIN_PASSWORD) {
      try { process.env.OPENLIST_ADMIN_PASSWORD = (await fsp.readFile(adminSecretPath, 'utf8')).trim(); } catch {}
    }
  } catch (error) {
    console.error('[bootstrap]', error.message);
    process.env.OPENLIST_BOOTSTRAP_ERROR = error.message;
  }
  startApp();
})().catch((error) => { console.error(error); process.exit(1); });

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));