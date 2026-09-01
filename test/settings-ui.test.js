const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const indexSource = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const uiSource = fs.readFileSync(path.join(root, 'public', 'ui-shell.js'), 'utf8');
const settingsCss = fs.readFileSync(path.join(root, 'public', 'settings-center.css'), 'utf8');

test('settings center keeps the existing functional controls', () => {
  assert.match(indexSource, /id="webdavUrl"/);
  assert.match(indexSource, /id="newSitePassword"/);
  assert.match(indexSource, /id="clearChatBtn"/);
  assert.match(indexSource, /id="settingsNotice"/);
});

test('settings center exposes WebDAV, site and chat navigation', () => {
  assert.match(uiSource, /settings-center\.css\?v=4\.1/);
  assert.match(uiSource, /title: 'WebDAV'/);
  assert.match(uiSource, /title: '站点设置'/);
  assert.match(uiSource, /title: '聊天设置'/);
  assert.match(uiSource, /dataSettingsPanel|dataset\.settingsPanel/);
  assert.match(uiSource, /setSettingsTab\('webdav'\)/);
});

test('desktop settings layout is two-column with readable typography', () => {
  assert.match(settingsCss, /grid-template-columns:220px minmax\(0,1fr\)/);
  assert.match(settingsCss, /settings-nav-copy strong\{font-size:14px/);
  assert.match(settingsCss, /setting-title strong\{font-size:18px/);
  assert.match(settingsCss, /form-grid input[\s\S]*font-size:14px/);
  assert.match(settingsCss, /@media \(max-width:760px\)/);
});
