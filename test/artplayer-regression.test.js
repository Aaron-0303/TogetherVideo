const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const indexSource = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const transportSource = fs.readFileSync(path.join(root, 'public', 'media-transport.js'), 'utf8');
const hybridSource = fs.readFileSync(path.join(root, 'public', 'hybrid-media.js'), 'utf8');
const stabilitySource = fs.readFileSync(path.join(root, 'public', 'media-stability.js'), 'utf8');
const workerSource = fs.readFileSync(path.join(root, 'public', 'sw.js'), 'utf8');
const mediaServiceSource = fs.readFileSync(path.join(root, 'src', 'media-service.js'), 'utf8');
const routesSource = fs.readFileSync(path.join(root, 'src', 'http-routes.js'), 'utf8');
const pkg = require('../package.json');

test('3.2.2 restores the known-good native media runtime instead of Artplayer', () => {
  assert.equal(pkg.version, '3.2.2');
  assert.match(indexSource, /\/media-transport\.js\?v=3\.2\.2/);
  assert.match(indexSource, /\/hybrid-media\.js\?v=3\.2\.2/);
  assert.match(indexSource, /\/media-stability\.js\?v=3\.2\.2/);
  assert.doesNotMatch(indexSource, /\/vendor\/artplayer\/artplayer\.js/);
  assert.doesNotMatch(indexSource, /\/artplayer-media\.js/);
});

test('media load waits for the Service Worker controller and retries metadata failures', () => {
  assert.match(transportSource, /navigator\.serviceWorker\.register\('\/sw\.js\?v=3\.2\.2'/);
  assert.match(stabilitySource, /window\.MediaTransport\?\.ready\?\.\(\)/);
  assert.match(stabilitySource, /METADATA_TIMEOUT_MS\s*=\s*15000/);
  assert.match(stabilitySource, /MAX_LOAD_RETRIES\s*=\s*2/);
  assert.match(stabilitySource, /searchParams\.set\('_fresh', '1'\)/);
});

test('provider media requests are bounded and never forward stale If-Range state', () => {
  assert.match(workerSource, /RANGE_CHUNK_BYTES\s*=\s*16 \* 1024 \* 1024/);
  assert.match(workerSource, /headers\.set\('Range', boundedMediaRange\(request\.headers\.get\('range'\)\)\)/);
  assert.doesNotMatch(workerSource, /If-Range/);
});

test('browser media bytes remain provider-direct through a 307 resolver', () => {
  assert.match(routesSource, /res\.status\(307\)\.set\('Location', destination\.toString\(\)\)\.end\(\)/);
  assert.doesNotMatch(routesSource, /MEDIA_BRIDGE_WORKER/);
  assert.doesNotMatch(routesSource, /app\.get\('\/api\/media\/url'/);
});

test('diagnostics require a real HTTP 206 Content-Range response', () => {
  assert.match(mediaServiceSource, /const range = await probe\('GET', \{ Range: 'bytes=0-0' \}\)/);
  assert.match(mediaServiceSource, /range\.status === 206/);
  assert.match(mediaServiceSource, /rangeVerified/);
});

test('HybridMedia still exposes the room client contract', () => {
  assert.match(hybridSource, /window\.HybridMedia = HybridMedia/);
  assert.match(hybridSource, /getBufferedAhead\(\)/);
  assert.match(hybridSource, /get hasRenderedFrame\(\)/);
});
