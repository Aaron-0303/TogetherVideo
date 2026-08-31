const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const appSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

test('late join uses one forced metadata catch-up and no second forced first-frame seek', () => {
  const connectBlock = appSource.match(/socket\.on\('connect',[\s\S]*?\n\s*\}\);/)?.[0] || '';
  assert.ok(connectBlock);
  assert.doesNotMatch(connectBlock, /requestSync\(true\)/);

  const loadMediaBlock = appSource.match(/function loadMedia\(snapshot\)[\s\S]*?function clearMedia/)?.[0] || '';
  assert.match(loadMediaBlock, /requestSync\(true\)/);

  const firstRenderBlock = appSource.match(/player\.addEventListener\('firstrender'[\s\S]*?\n\}\);/)?.[0] || '';
  assert.ok(firstRenderBlock);
  assert.match(firstRenderBlock, /requestSync\(false\)/);
  assert.doesNotMatch(firstRenderBlock, /requestSync\(true\)/);
});

test('programmatic seek suppression is transaction-based instead of a short timeout', () => {
  assert.match(appSource, /state\.expectedSeek = \{ target: value, issuedAt: Date\.now\(\) \}/);
  assert.doesNotMatch(appSource, /expectedSeek\s*=\s*\{[^}]*until:/);
  assert.match(appSource, /PROGRAMMATIC_SEEK_TOLERANCE/);
});

test('user scrubbing publishes only after seek settles', () => {
  assert.match(appSource, /SEEK_COMMIT_DELAY_MS\s*=\s*320/);
  assert.match(appSource, /function commitUserSeek\(\)/);
  assert.match(appSource, /userSeekCommitTimer = setTimeout\(commitUserSeek, SEEK_COMMIT_DELAY_MS\)/);
});

test('intentional seek and startup transitions have a stall grace window', () => {
  assert.match(appSource, /STARTUP_GRACE_MS\s*=\s*7000/);
  assert.match(appSource, /armSeekGrace\(STARTUP_GRACE_MS\)/);
  assert.match(appSource, /remainingGrace = state\.seekGraceUntil - Date\.now\(\)/);
  assert.match(appSource, /armSeekGrace\(SEEK_GRACE_MS\)/);
});

test('programmatic play and pause acknowledgements do not expire on slow Safari events', () => {
  assert.doesNotMatch(appSource, /expectedPlayUntil|expectedPauseUntil/);
  assert.match(appSource, /state\.expectedPlay = true/);
  assert.match(appSource, /state\.expectedPause = true/);
});

test('shared buffering needs sustained evidence before pausing both viewers', () => {
  assert.match(serverSource, /BUFFERING_PAUSE_DELAY_MS\s*=\s*2500/);
  assert.match(serverSource, /BUFFERING_RESUME_DELAY_MS\s*=\s*1000/);
});
