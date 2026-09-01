const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const indexSource = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const uiSource = fs.readFileSync(path.join(root, 'public', 'ui-shell.js'), 'utf8');
const roomPanelSource = fs.readFileSync(path.join(root, 'public', 'room-panel.js'), 'utf8');
const styleSource = fs.readFileSync(path.join(root, 'public', 'styles.css'), 'utf8');
const transportSource = fs.readFileSync(path.join(root, 'public', 'media-transport.js'), 'utf8');
const adapterSource = fs.readFileSync(path.join(root, 'public', 'artplayer-media.js'), 'utf8');
const stabilitySource = fs.readFileSync(path.join(root, 'public', 'media-stability.js'), 'utf8');
const workerSource = fs.readFileSync(path.join(root, 'public', 'sw.js'), 'utf8');
const mediaServiceSource = fs.readFileSync(path.join(root, 'src', 'media-service.js'), 'utf8');
const routesSource = fs.readFileSync(path.join(root, 'src', 'http-routes.js'), 'utf8');
const serverSource = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const pkg = require('../package.json');

test('4.1 uses ArtPlayer UI on top of the stable media transport', () => {
  assert.equal(pkg.version, '4.1.0');
  const transportAt = indexSource.indexOf('/media-transport.js?v=4.1');
  const artRuntimeAt = indexSource.indexOf('/vendor/artplayer/artplayer.js?v=5.4.0');
  const adapterAt = indexSource.indexOf('/artplayer-media.js?v=4.1');
  const stabilityAt = indexSource.indexOf('/media-stability.js?v=4.1');
  const roomPanelAt = indexSource.indexOf('/room-panel.js?v=4.1');
  const appAt = indexSource.indexOf('/app-3.1.js?v=4.1');
  assert.ok(transportAt >= 0 && artRuntimeAt > transportAt && adapterAt > artRuntimeAt);
  assert.ok(stabilityAt > adapterAt && roomPanelAt > stabilityAt && appAt > roomPanelAt);
  assert.doesNotMatch(indexSource, /\/hybrid-media\.js/);
});

test('4.1 shell keeps persistent light and dark themes', () => {
  assert.match(indexSource, /data-theme-toggle/);
  assert.match(indexSource, /ui-shell\.js\?v=4\.1/);
  assert.match(uiSource, /togethervideo-theme/);
  assert.match(uiSource, /prefers-color-scheme: dark/);
  assert.match(styleSource, /html\[data-theme="light"\]/);
  assert.match(styleSource, /--surface:/);
});

test('4.1 fills the viewport with player-left and room-or-playlist right tabs', () => {
  assert.match(indexSource, /id="roomTabBtn"/);
  assert.match(indexSource, /id="playlistTabBtn"/);
  assert.match(indexSource, /id="roomTabPanel"/);
  assert.match(indexSource, /id="playlistTabPanel"/);
  assert.match(indexSource, /id="chatForm"/);
  assert.match(indexSource, /id="chatMessages"/);
  assert.match(indexSource, /id="libraryList"/);
  assert.match(roomPanelSource, /setSidebarTab\('playlist'\)/);
  assert.match(roomPanelSource, /chat:history/);
  assert.match(roomPanelSource, /chat:message/);
  assert.match(styleSource, /\.watch-layout\{[^}]*width:100vw[^}]*height:calc\(100vh - 52px\)/);
  assert.match(styleSource, /grid-template-columns:minmax\(0,1fr\) 340px/);
  assert.match(styleSource, /\.video-shell\{[^}]*height:100%/);
  assert.match(styleSource, /\.room-sidebar\{[^}]*height:100%/);
  assert.doesNotMatch(styleSource, /width:min\(1760px,100%\)/);
  assert.doesNotMatch(indexSource, /library-drawer|library-handle|>ArtPlayer<|独立媒体线路/);
});

test('ArtPlayer adapter keeps the room client contract while using native video', () => {
  assert.match(adapterSource, /new ArtplayerClass\(/);
  assert.match(adapterSource, /this\.video = this\.art\.video/);
  assert.match(adapterSource, /this\.mode = 'native'/);
  assert.match(adapterSource, /window\.HybridMedia = ArtplayerMedia/);
  assert.match(adapterSource, /getBufferedAhead\(\)/);
  assert.match(adapterSource, /get hasRenderedFrame\(\)/);
  assert.match(adapterSource, /playbackRate:\s*false/);
});

test('media load waits for the Service Worker controller before ArtPlayer gets a source', () => {
  assert.match(transportSource, /navigator\.serviceWorker\.register\('\/sw\.js\?v=4\.1'/);
  assert.match(stabilitySource, /window\.MediaTransport\?\.ready\?\.\(\)/);
  assert.match(stabilitySource, /originalLoad\.call\(this\)/);
  assert.match(adapterSource, /this\.video\.src = resolved/);
  assert.doesNotMatch(adapterSource, /navigator\.serviceWorker\.register/);
});

test('provider reads stay bounded, discard stale If-Range, and require real partial responses', () => {
  assert.match(workerSource, /RANGE_CHUNK_BYTES\s*=\s*16 \* 1024 \* 1024/);
  assert.match(workerSource, /headers\.set\('Range', boundedMediaRange\(request\.headers\.get\('range'\)\)\)/);
  assert.doesNotMatch(workerSource, /headers\.set\(['"]If-Range/);
  assert.match(workerSource, /function validPartialResponse\(response\)/);
  assert.match(workerSource, /response\.status !== 206/);
  assert.match(workerSource, /resolveProviderUrl\(mediaPath, true\)/);
  assert.match(workerSource, /X-TogetherVideo-Media-Version', '4\.1'/);
});

test('browser media bytes remain provider-direct through a 307 resolver', () => {
  assert.match(routesSource, /res\.status\(307\)\.set\('Location', destination\.toString\(\)\)\.end\(\)/);
  assert.doesNotMatch(routesSource, /MEDIA_BRIDGE_WORKER/);
  assert.match(serverSource, /media bytes are never proxied by this server/);
});

test('diagnostics require a real HTTP 206 Content-Range response', () => {
  assert.match(mediaServiceSource, /const range = await probe\('GET', \{ Range: 'bytes=0-0' \}\)/);
  assert.match(mediaServiceSource, /range\.status === 206/);
  assert.match(mediaServiceSource, /rangeVerified/);
});

test('server serves the installed ArtPlayer browser runtime', () => {
  assert.equal(pkg.dependencies?.artplayer, '5.4.0');
  assert.match(serverSource, /node_modules', 'artplayer', 'dist'/);
  assert.match(serverSource, /app\.use\('\/vendor\/artplayer'/);
});
