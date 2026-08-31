const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'hybrid-media.js'), 'utf8');
const appSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

test('Safari/iPad never enters the libmedia fallback path', () => {
  assert.match(source, /if \(isAppleMobile\(\)\) \{[\s\S]{0,500}fallbackunavailable/);
  assert.match(source, /async _startFallback\(nativeError\) \{[\s\S]{0,120}isAppleMobile\(\)/);
});

test('non-Safari compatibility core keeps bounded preload and resize', () => {
  assert.match(source, /preLoadTime:\s*4\b/);
  assert.match(source, /ResizeObserver/);
  assert.match(source, /player\.resize\(width, height\)/);
});

test('pipeline progress is not forwarded as HTML buffering progress', () => {
  assert.doesNotMatch(source, /Events\.PROGRESS[\s\S]{0,100}_emit\(['"]progress['"]\)/);
});

test('player exposes rendered-frame and buffered-ahead state', () => {
  assert.match(source, /get hasRenderedFrame\(\)/);
  assert.match(source, /getBufferedAhead\(\)/);
});

test('initial media preparation does not enter shared buffering protection', () => {
  assert.match(appSource, /mediaRecovery\.reset\(\{ preparing: true \}\)/);
  assert.match(appSource, /state\.mediaReady = false;[\s\S]{0,180}setBuffering\(false\)/);
  const fallbackStart = appSource.match(/player\.addEventListener\('fallbackstart'[\s\S]*?\n\}\);/s)?.[0] || '';
  assert.ok(fallbackStart);
  assert.doesNotMatch(fallbackStart, /setBuffering\(true\)/);
});

test('sync corrections are frozen during media recovery', () => {
  assert.match(appSource, /mediaRecovery\.shouldFreezeSync\(\)[\s\S]{0,700}暂停对轴/);
});
