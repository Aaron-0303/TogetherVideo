const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const appSource = fs.readFileSync(path.join(root, 'public', 'app-3.1.js'), 'utf8');
const coordinatorSource = fs.readFileSync(path.join(root, 'src', 'room-coordinator.js'), 'utf8');
const indexSource = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');

test('runtime keeps the single room app without old continuous correction engines', () => {
  assert.match(indexSource, /app-3\.1\.js/);
  assert.doesNotMatch(indexSource, /sync-policy\.js/);
  assert.doesNotMatch(indexSource, /media-recovery\.js/);
  assert.doesNotMatch(appSource, /SyncPolicy|MediaRecovery|correctionRate|setProgrammaticRate/);
});

test('manual scrubbing publishes one settled target instead of a stream of seek commands', () => {
  const seekingBlock = appSource.match(/player\.addEventListener\('seeking'[\s\S]*?\n\}\);/)?.[0] || '';
  assert.ok(seekingBlock);
  assert.match(seekingBlock, /state\.userSeeking = true/);
  assert.match(appSource, /USER_SEEK_SETTLE_MS\s*=\s*260/);
  assert.match(appSource, /function commitUserSeek\(\)/);
  assert.match(appSource, /emitControl\('player:seek'/);
});

test('play and seek use short shared server-time starts without readiness barriers', () => {
  assert.match(coordinatorSource, /startDelayMs = Number\(options\.startDelayMs \|\| 500\)/);
  assert.match(coordinatorSource, /schedulePlayAt\(/);
  assert.match(coordinatorSource, /startAt = Date\.now\(\) \+ Math\.max/);
  assert.match(coordinatorSource, /reason: 'pause'/);
  assert.match(coordinatorSource, /'seek-resume'/);
  assert.doesNotMatch(coordinatorSource, /everyoneReady|bufferingDelayMs|reason: 'buffering'/);
});

test('buffering is telemetry only and never pauses the other viewer', () => {
  const bufferingBlock = coordinatorSource.match(/setBuffering\(participantId[\s\S]*?\n\s*}\n\n\s*resetBuffering/)?.[0] || '';
  assert.ok(bufferingBlock);
  assert.match(bufferingBlock, /participant\.buffering\.set/);
  assert.match(bufferingBlock, /broadcastPresence\(\)/);
  assert.doesNotMatch(bufferingBlock, /room\.apply|schedulePlayAt|barrier|setTimeout/);
});

test('automatic drift checks are advisory; only manual resync can move both viewers', () => {
  assert.match(appSource, /DESYNC_THRESHOLD_SECONDS\s*=\s*2\.5/);
  assert.match(appSource, /emitControl\('player:desync'/);
  assert.match(coordinatorSource, /payload\.manual !== true/);
  assert.match(coordinatorSource, /'resync'/);
  assert.doesNotMatch(appSource, /playbackRate\s*[+\-]=/);
});

test('late join is presence-only and never pauses an already playing viewer', () => {
  const joinBlock = coordinatorSource.match(/handleJoin\(\)[\s\S]*?\n\s*}/)?.[0] || '';
  assert.ok(joinBlock);
  assert.match(joinBlock, /return null/);
  assert.doesNotMatch(joinBlock, /room\.apply|barrier|pause/);
});
