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

test('3.2 runtime loads Artplayer and removes old media bridge layers from the page', () => {
  assert.equal(pkg.version, '3.2.0');
  assert.match(indexSource, /\/vendor\/artplayer\/artplayer\.js\?v=5\.4\.0/);
  assert.match(indexSource, /\/artplayer-media\.js\?v=3\.2/);
  assert.doesNotMatch(indexSource, /media-transport\.js/);
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

test('3.2 resolves a fresh final provider URL before assigning native video src', () => {
  assert.match(routesSource, /app\.get\('\/api\/media\/url'/);
  assert.match(routesSource, /resolvePlayable\(mediaPath, \{ fresh: true \}\)/);
  assert.match(adapterSource, /fetch\(`\/api\/media\/url\?path=/);
  assert.match(adapterSource, /this\.video\.src = resolved/);
});

test('native media path does not manually proxy or slice Range requests', () => {
  assert.doesNotMatch(adapterSource, /Range\s*:/);
  assert.doesNotMatch(adapterSource, /Content-Range/);
  assert.doesNotMatch(adapterSource, /ReadableStream/);
  assert.doesNotMatch(adapterSource, /serviceWorker\.register/);
});

test('server serves Artplayer from the installed npm package', () => {
  assert.match(serverSource, /node_modules', 'artplayer', 'dist'/);
  assert.match(serverSource, /app\.use\('\/vendor\/artplayer'/);
});
