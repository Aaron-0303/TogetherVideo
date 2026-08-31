const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const swSource = fs.readFileSync(path.join(root, 'public', 'sw.js'), 'utf8');
const indexSource = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const transportSource = fs.readFileSync(path.join(root, 'public', 'media-transport.js'), 'utf8');

test('browser media bridge bounds open-ended provider ranges', () => {
  assert.match(swSource, /RANGE_CHUNK_BYTES\s*=\s*16\s*\*\s*1024\s*\*\s*1024/);
  assert.match(swSource, /function boundedMediaRange\(/);
  assert.match(swSource, /headers\.set\('Range', boundedMediaRange\(request\.headers\.get\('range'\)\)\)/);
  assert.doesNotMatch(swSource, /request\.headers\.get\('range'\)\s*\|\|\s*'bytes=0-'/);
});

test('provider fetch follows media-element cancellation', () => {
  assert.match(swSource, /fetchWithTimeout\(source\.url,[\s\S]*PROVIDER_HEADER_TIMEOUT_MS, request\.signal\)/);
  assert.match(swSource, /parentSignal\?\.addEventListener\?\.\('abort'/);
});

test('native player no longer asks the browser to preload the movie aggressively', () => {
  assert.match(indexSource, /<video[^>]+preload="metadata"/);
  assert.doesNotMatch(indexSource, /<video[^>]+preload="auto"/);
});

test('3.1.2 forces browsers to update the media worker', () => {
  assert.match(transportSource, /register\('\/sw\.js\?v=3\.1\.2'/);
  assert.match(indexSource, /media-transport\.js\?v=3\.1\.2/);
});
