const path = require('path');

function bool(name, fallback = false) {
  const value = process.env[name];
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}
function integer(name, fallback) {
  const n = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(n) ? n : fallback;
}
function normalizeRoot(value) {
  let root = String(value || '/').trim();
  if (!root.startsWith('/')) root = `/${root}`;
  root = path.posix.normalize(root);
  if (root.length > 1) root = root.replace(/\/$/, '');
  return root;
}

module.exports = {
  host: (process.env.HOST || '0.0.0.0').trim(),
  port: integer('PORT', 3000),
  sitePassword: process.env.SITE_PASSWORD || 'change-me',
  cookieSecure: bool('COOKIE_SECURE', false),
  trustProxy: bool('TRUST_PROXY', true),
  defaultRoom: (process.env.DEFAULT_ROOM || 'ours').trim(),
  maxRoomUsers: integer('MAX_ROOM_USERS', 2),
  dataFile: process.env.DATA_FILE || path.join(process.cwd(), 'data', 'state.json'),
  settingsFile: process.env.SETTINGS_FILE || path.join(process.cwd(), 'data', 'settings.json'),
  openlistBootstrapError: process.env.OPENLIST_BOOTSTRAP_ERROR || '',
  openlistAdminPassword: process.env.OPENLIST_ADMIN_PASSWORD || '',
  openlist: {
    baseUrl: (process.env.OPENLIST_BASE_URL || 'http://127.0.0.1:5244').replace(/\/$/, ''),
    publicUrl: (process.env.OPENLIST_PUBLIC_URL || '').replace(/\/$/, ''),
    token: process.env.OPENLIST_TOKEN || '',
    root: normalizeRoot(process.env.OPENLIST_ROOT || '/QuarkTV'),
    pathPassword: process.env.OPENLIST_PATH_PASSWORD || '',
    timeoutMs: integer('OPENLIST_TIMEOUT_MS', 15000),
  },
};
