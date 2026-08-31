const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const indexSource = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const adapterSource = fs.readFileSync(path.join(root, 'public', 'artplayer-media.js'), 'utf8');
const routesSource = fs.readFileSync(path.join(root, 'src', 'http-routes.js'), 'utf8');
const serverSource = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const pkg = require('../package.json');

test('3.2.1 runtime keeps Artplayer and enables the minimal MIME bridge', () => {
  assert.equal(pkg.version, '3.2.1');
  assert.match(indexSource, /\/vendor\/artplayer\/artplayer\.js\?v=5\.4\.0/);
  assert.match(indexSource, /\/artplayer-media\.js\?v=3\.2\.1/);
  assert.match(adapterSource, /BRIDGE_SCRIPT = '\/sw\.js\?v=3\.2\.1'/);
  assert.doesNotMatch(indexSource, /media-stability\.js/);
  assert.doesNotMatch(indexSource, /hybrid-media\.js/);
});

test('Artplayer adapter keeps the room client API while using one native video element', () => {
  assert.match(adapterSource, /new ArtplayerClass\(/);
  assert.match(adapterSource, /this\.mode = 'native'/);
  assert.match(adapterSource, /this\.video = this\.art\.video/);
  assert.match(adapterSource, /window\.HybridMedia = ArtplayerMedia/);
  assert.match(adapterSource, /getBufferedAhead\(\)/);
  assert.match(adapterSource, /get hasRenderedFrame\(\)/);
});

test('3.2.1 assigns the same-origin logical media URL only after the worker controls the page', () => {
  assert.match(routesSource, /app\.get\('\/api\/media\/url'/);
  assert.match(routesSource, /resolvePlayable\(mediaPath, \{ fresh: true \}\)/);
  assert.match(adapterSource, /navigator\.serviceWorker\.register\(BRIDGE_SCRIPT/);
  assert.match(adapterSource, /Promise\.resolve\(this\.bridgeReady\)/);
  assert.match(adapterSource, /this\.video\.src = resolved/);
  assert.doesNotMatch(adapterSource, /fetch\(`\/api\/media\/url\?path=/);
});

test('MIME bridge forwards native Range unchanged and never slices it', () => {
  assert.match(serverSource, /const range = request\.headers\.get\('range'\)/);
  assert.match(serverSource, /if \(range\) headers\.set\('Range', range\)/);
  assert.doesNotMatch(serverSource, /RANGE_CHUNK_BYTES/);
  assert.doesNotMatch(serverSource, /boundedMediaRange/);
});

test('MIME bridge repairs 123 download headers without proxying through Node', () => {
  assert.match(serverSource, /headers\.set\('Content-Type', mimeForPath\(mediaPath\)\)/);
  assert.match(serverSource, /headers\.set\('Content-Disposition', 'inline'\)/);
  assert.match(serverSource, /headers\.set\('Accept-Ranges', 'bytes'\)/);
  assert.match(serverSource, /X-TogetherVideo-Media-Mode', 'mime-bridge'/);
  assert.match(serverSource, /media bytes are never proxied by this server/);
});

test('server serves Artplayer from the installed npm package', () => {
  assert.match(serverSource, /node_modules', 'artplayer', 'dist'/);
  assert.match(serverSource, /app\.use\('\/vendor\/artplayer'/);
});
