const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const routes = fs.readFileSync(path.join(root, 'src', 'http-routes.js'), 'utf8');
const unlock = fs.readFileSync(path.join(root, 'public', 'playback-unlock.js'), 'utf8');
const app = fs.readFileSync(path.join(root, 'public', 'app-3.1.js'), 'utf8');
const index = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');

test('browser media bootstrap always resolves a fresh provider URL', () => {
  assert.match(routes, /resolvePlayable\(checked\.mediaPath, \{ fresh: true \}\)/);
});

test('late join autoplay rejection falls back to visible muted playback', () => {
  assert.match(unlock, /NotAllowedError/);
  assert.match(unlock, /video\.muted = true/);
  assert.match(unlock, /await originalPlay/);
  assert.match(unlock, /点击开启声音并加入同步播放/);
});

test('sound unlock happens directly inside a user gesture', () => {
  assert.match(unlock, /video\.muted = false/);
  assert.match(unlock, /stopImmediatePropagation/);
  assert.match(unlock, /\}, true\);/);
});

test('unlock shim loads after 3.1 app creates TogetherMediaPlayer', () => {
  const appAt = index.indexOf('/app-3.1.js');
  const unlockAt = index.indexOf('/playback-unlock.js');
  assert.ok(appAt >= 0);
  assert.ok(unlockAt > appAt);
  assert.match(app, /window\.TogetherMediaPlayer = player/);
});

test('late join UI waits for a shared ready barrier instead of chasing the live clock', () => {
  assert.match(app, /barrier\.reason === 'join'/);
  assert.match(app, /双方缓存到同一位置后会同时继续播放/);
  assert.doesNotMatch(app, /playbackRate\s*[+\-]=/);
});
