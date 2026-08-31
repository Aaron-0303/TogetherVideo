const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'hybrid-media.js'), 'utf8');
const appSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

test('iPad fallback keeps a short preload window', () => {
  assert.match(source, /preLoadTime:\s*4\b/);
  assert.doesNotMatch(source, /preLoadTime:\s*(?:[1-9]\d|\d{3,})\b/);
});

test('iPad fallback prefers MSE only after libmedia codec checks', () => {
  assert.match(source, /checkUseMSE:\s*\(\)\s*=>\s*isAppleMobile\(\)/);
});

test('libmedia renderer is resized to the visible player box', () => {
  assert.match(source, /ResizeObserver/);
  assert.match(source, /player\.resize\(width, height\)/);
});

test('pipeline progress is not forwarded as HTML buffering progress', () => {
  assert.doesNotMatch(source, /Events\.PROGRESS[\s\S]{0,100}_emit\(['"]progress['"]\)/);
});

test('libmedia readiness waits for the first rendered frame', () => {
  assert.match(source, /if \(this\.avFirstFrame\) return HTMLMediaElement\.HAVE_ENOUGH_DATA/);
  assert.match(source, /if \(this\.avLoaded\) return HTMLMediaElement\.HAVE_METADATA/);
  assert.match(source, /FIRST_VIDEO_RENDERED[\s\S]{0,120}_markFirstFrame/);
});

test('initial media preparation does not enter shared buffering protection', () => {
  assert.match(appSource, /if \(state\.sourceLoading \|\| !state\.mediaReady\) return;/);
  assert.match(appSource, /state\.mediaReady = false;[\s\S]{0,120}setBuffering\(false\)/);
  const fallbackStart = appSource.match(/player\.addEventListener\('fallbackstart'[\s\S]*?\n\}\);/s)?.[0] || '';
  assert.ok(fallbackStart);
  assert.doesNotMatch(fallbackStart, /setBuffering\(true\)/);
});
