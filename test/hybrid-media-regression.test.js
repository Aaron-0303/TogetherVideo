const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'hybrid-media.js'), 'utf8');
const appSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'app-3.1.js'), 'utf8');

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

test('barrier preparation owns seeking and does not report it as playback buffering', () => {
  assert.match(appSource, /function prepareBarrier\(barrier\)/);
  assert.match(appSource, /pauseLocal\(\)/);
  assert.match(appSource, /setProgrammaticSeek\(Number\(barrier\.target \|\| 0\)\)/);
  const beginBuffering = appSource.match(/function beginBuffering\(\)[\s\S]*?function endBuffering/)?.[0] || '';
  assert.match(beginBuffering, /player\.seeking \|\| state\.barrier/);
});

test('3.1 never uses media recovery to drive timeline correction', () => {
  assert.doesNotMatch(appSource, /MediaRecovery|SyncPolicy|correctionRate/);
  assert.match(appSource, /emitControl\('player:desync'/);
});
