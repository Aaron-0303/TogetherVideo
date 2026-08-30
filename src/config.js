const path = require('path');

function bool(name, fallback = false) {
  const value = process.env[name];
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function integer(name, fallback) {
  const value = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(value) ? value : fallback;
}

const dataDir = path.resolve(process.env.DATA_DIR || path.join(process.cwd(), 'data'));

module.exports = {
  host: (process.env.HOST || '0.0.0.0').trim(),
  port: integer('PORT', 3000),
  sitePassword: process.env.SITE_PASSWORD || 'change-me',
  cookieSecure: bool('COOKIE_SECURE', false),
  trustProxy: bool('TRUST_PROXY', true),
  maxParticipants: 2,
  dataDir,
  settingsFile: path.join(dataDir, 'settings.json'),
  stateFile: path.join(dataDir, 'watch-state.json'),
};
