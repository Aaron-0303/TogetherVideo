const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const appSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const coordinatorSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'room-coordinator.js'), 'utf8');

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
  assert.match(appSource, /state\.expectedSeek = \{[\s\S]{0,220}target: value,[\s\S]{0,220}revision,[\s\S]{0,220}reason:/);
  assert.doesNotMatch(appSource, /expectedSeek\s*=\s*\{[^}]*until:/);
  assert.match(appSource, /PROGRAMMATIC_SEEK_TOLERANCE\s*=\s*2\.0/);
});

test('an in-flight programmatic seek is not restarted by periodic sync samples', () => {
  const setterBlock = appSource.match(/function setProgrammaticSeek\(target, context = \{\}\)[\s\S]*?function setProgrammaticPause/)?.[0] || '';
  assert.ok(setterBlock);
  assert.match(setterBlock, /const inFlight = Boolean\(active && \(state\.seeking \|\| player\.seeking\)\)/);
  assert.match(setterBlock, /reason === 'seek'[\s\S]{0,180}revision > Number\(active\.revision \|\| 0\)/);
  assert.match(setterBlock, /if \(!newerExplicitSeek\) return/);

  const playbackBlock = appSource.match(/function applyPlayback\(snapshot[\s\S]*?function refreshActiveLibraryItem/)?.[0] || '';
  assert.ok(playbackBlock);
  assert.match(playbackBlock, /state\.expectedSeek && \(state\.seeking \|\| player\.seeking\) && snapshot\.reason !== 'seek'/);
  assert.match(playbackBlock, /正在跳转 · 等待媒体定位/);
});

test('slow seeking events keep the armed programmatic transaction until seeked', () => {
  const seekingBlock = appSource.match(/player\.addEventListener\('seeking'[\s\S]*?\n\}\);/)?.[0] || '';
  assert.ok(seekingBlock);
  assert.match(seekingBlock, /if \(state\.expectedSeek\) \{[\s\S]{0,100}state\.seekOrigin = 'programmatic'/);
  assert.doesNotMatch(seekingBlock, /Math\.abs\(current - expected\.target\)/);

  const seekedBlock = appSource.match(/player\.addEventListener\('seeked'[\s\S]*?\n\}\);/)?.[0] || '';
  assert.ok(seekedBlock);
  assert.match(seekedBlock, /state\.seekOrigin === 'programmatic'/);
  assert.match(seekedBlock, /Math\.abs\(current - expected\.target\) <= PROGRAMMATIC_SEEK_TOLERANCE/);
});

test('stuck programmatic seeks recover instead of showing jumping forever', () => {
  assert.match(appSource, /PROGRAMMATIC_SEEK_TIMEOUT_MS\s*=\s*15000/);
  assert.match(appSource, /reloadCurrentMedia\('seek-timeout'\)/);
  assert.match(appSource, /reason === 'seek-timeout' \? '跳转超时'/);
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
  assert.match(coordinatorSource, /pauseDelayMs = Number\(options\.pauseDelayMs \|\| 2500\)/);
  assert.match(coordinatorSource, /resumeDelayMs = Number\(options\.resumeDelayMs \|\| 1000\)/);
});
