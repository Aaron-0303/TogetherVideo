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
const adminSecretPath = path.join(runtimeDir, '.admin-secret');
const baseUrl = process.env.OPENLIST_BASE_URL || 'http://127.0.0.1:5244';
let openlistProcess = null;
let appProcess = null;

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function isOpenListReady() {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    const response = await fetch(`${baseUrl}/api/public/settings`, { signal: controller.signal });
    clearTimeout(timer);
    return response.ok;
  } catch { return false; }
}

function assetName() {
  if (process.platform !== 'linux') throw new Error('自动 OpenList 当前只支持 Linux 服务器；其他系统请设置 OPENLIST_MANAGED=false 并提供外部 OpenList。');
  if (process.arch === 'x64') return 'openlist-linux-amd64.tar.gz';
  if (process.arch === 'arm64') return 'openlist-linux-arm64.tar.gz';
  throw new Error(`暂不支持自动安装 OpenList 的架构: ${process.arch}`);
}

async function download(url, target) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok || !response.body) throw new Error(`下载 OpenList 失败: HTTP ${response.status}`);
  const file = fs.createWriteStream(target);
  await new Promise((resolve, reject) => {
    const reader = response.body.getReader();
    const pump = async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!file.write(Buffer.from(value))) await new Promise((r) => file.once('drain', r));
        }
        file.end(resolve);
      } catch (error) { file.destroy(); reject(error); }
    };
    pump();
  });
}

async function ensureBinary() {
  await fsp.mkdir(runtimeDir, { recursive: true });
  try { await fsp.access(binaryPath, fs.constants.X_OK); return; } catch {}
  const asset = assetName();
  const url = `https://github.com/OpenListTeam/OpenList/releases/latest/download/${asset}`;
  console.log(`[bootstrap] downloading OpenList: ${asset}`);
  await download(url, archivePath);
  await tar.x({ file: archivePath, cwd: runtimeDir });
  await fsp.chmod(binaryPath, 0o755);
  await fsp.rm(archivePath, { force: true });
  console.log('[bootstrap] OpenList binary ready');
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
    console.warn('[bootstrap] unable to set OpenList admin password:', (result.stderr || result.stdout || '').trim());
    return false;
  }
  return true;
}

async function startManagedOpenList() {
  if (String(process.env.OPENLIST_MANAGED || 'true').toLowerCase() === 'false') return null;
  if (await isOpenListReady()) {
    console.log('[bootstrap] using existing OpenList at', baseUrl);
    return null;
  }
  await ensureBinary();
  openlistProcess = spawn(binaryPath, ['server', '--force-bin-dir', '--log-std'], {
    cwd: runtimeDir,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  openlistProcess.stdout.on('data', (chunk) => process.stdout.write(`[openlist] ${chunk}`));
  openlistProcess.stderr.on('data', (chunk) => process.stderr.write(`[openlist] ${chunk}`));
  openlistProcess.on('exit', (code, signal) => console.warn(`[bootstrap] OpenList exited code=${code} signal=${signal || ''}`));
  const ready = await waitForOpenList();
  if (!ready) throw new Error('OpenList 启动失败或 30 秒内未就绪');
  const secret = await ensureAdminSecret();
  setAdminPassword(secret);
  process.env.OPENLIST_ADMIN_PASSWORD = secret;
  return secret;
}

function startApp() {
  appProcess = spawn(process.execPath, ['server.js'], { cwd: root, env: process.env, stdio: 'inherit' });
  appProcess.on('exit', (code, signal) => {
    if (openlistProcess && openlistProcess.exitCode == null) openlistProcess.kill('SIGTERM');
    process.exitCode = code ?? (signal ? 1 : 0);
  });
}

function shutdown(signal) {
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
