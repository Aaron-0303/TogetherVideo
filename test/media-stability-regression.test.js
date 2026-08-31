const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const stabilitySource = fs.readFileSync(path.join(root, 'public', 'media-stability.js'), 'utf8');
const swSource = fs.readFileSync(path.join(root, 'public', 'sw.js'), 'utf8');
const indexSource = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const socketSource = fs.readFileSync(path.join(root, 'src', 'socket-gateway.js'), 'utf8');

test('media stability shim loads after HybridMedia and before the room app', () => {
  const hybrid = indexSource.indexOf('/hybrid-media.js');
  const stability = indexSource.indexOf('/media-stability.js');
  const app = indexSource.indexOf('/app-3.1.js');
  assert.ok(hybrid >= 0 && stability > hybrid && app > stability);
});

test('cold media load waits for the transport controller before issuing the real request', () => {
  assert.match(stabilitySource, /window\.MediaTransport\?\.ready\?\.\(\)/);
  assert.match(stabilitySource, /Promise\.resolve\(transportReady\)[\s\S]*?originalLoad\.call\(this\)/);
});

test('metadata black-screen state has bounded retries with a fresh provider URL', () => {
  assert.match(stabilitySource, /METADATA_TIMEOUT_MS\s*=\s*15000/);
  assert.match(stabilitySource, /MAX_LOAD_RETRIES\s*=\s*2/);
  assert.match(stabilitySource, /searchParams\.set\('_fresh', '1'\)/);
  assert.match(stabilitySource, /finishWithLoadFailure/);
  assert.match(stabilitySource, /player\._emit\?\.\('error'\)/);
});

test('duplicate programmatic seek packets cannot restart the same in-flight seek', () => {
  assert.match(stabilitySource, /DUPLICATE_SEEK_TOLERANCE\s*=\s*0\.25/);
  assert.match(stabilitySource, /this\.video\?\.seeking/);
  assert.match(stabilitySource, /Math\.abs\(previous - target\) <= DUPLICATE_SEEK_TOLERANCE/);
});

test('native barrier readiness requires a meaningful real buffered range', () => {
  assert.match(stabilitySource, /REQUIRED_BUFFER_SECONDS\s*=\s*3\.0/);
  assert.match(stabilitySource, /FALLBACK_BUFFER_SECONDS\s*=\s*1\.0/);
  assert.match(stabilitySource, /raw >= REQUIRED_BUFFER_SECONDS \? raw : 0/);
  assert.match(stabilitySource, /HTMLMediaElement\.HAVE_CURRENT_DATA/);
  assert.match(stabilitySource, /HTMLMediaElement\.HAVE_METADATA/);
});

test('service worker honors forced fresh resolution and bounds provider header waits', () => {
  assert.match(swSource, /RESOLVER_TIMEOUT_MS\s*=\s*12000/);
  assert.match(swSource, /PROVIDER_HEADER_TIMEOUT_MS\s*=\s*15000/);
  assert.match(swSource, /requestUrl\.searchParams\.get\('_fresh'\) === '1'/);
  assert.match(swSource, /resolveProviderUrl\(mediaPath, forceFresh\)/);
  assert.match(swSource, /fetchWithTimeout/);
});

test('a newly-created join barrier is not delivered twice to the late viewer', () => {
  assert.match(socketSource, /const joinBarrier = coordinator\.handleJoin\(participantId, nickname\)/);
  assert.match(socketSource, /if \(!joinBarrier\) coordinator\.sendBarrier\(socket\)/);
});
