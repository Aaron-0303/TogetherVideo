const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const appSource = fs.readFileSync(path.join(root, 'public', 'app-3.1.js'), 'utf8');
const coordinatorSource = fs.readFileSync(path.join(root, 'src', 'room-coordinator.js'), 'utf8');
const indexSource = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');

test('3.1 runtime no longer loads the old continuous correction engines', () => {
  assert.match(indexSource, /app-3\.1\.js/);
  assert.doesNotMatch(indexSource, /sync-policy\.js/);
  assert.doesNotMatch(indexSource, /media-recovery\.js/);
  assert.doesNotMatch(appSource, /SyncPolicy|MediaRecovery|correctionRate|setProgrammaticRate/);
});

test('manual scrubbing pauses locally and publishes only the settled target', () => {
  const seekingBlock = appSource.match(/player\.addEventListener\('seeking'[\s\S]*?\n\}\);/)?.[0] || '';
  assert.ok(seekingBlock);
  assert.match(seekingBlock, /state\.userSeeking = true/);
  assert.match(seekingBlock, /pauseLocal\(\)/);

  assert.match(appSource, /USER_SEEK_SETTLE_MS\s*=\s*260/);
  assert.match(appSource, /function commitUserSeek\(\)/);
  assert.match(appSource, /emitControl\('player:seek'/);
});

test('barrier readiness requires target position and playable buffered media', () => {
  assert.match(appSource, /BARRIER_POSITION_TOLERANCE\s*=\s*1\.25/);
  assert.match(appSource, /BARRIER_BUFFER_SECONDS\s*=\s*1\.0/);
  assert.match(appSource, /function bufferedEnough\(\)/);
  assert.match(appSource, /player\.readyState >= HTMLMediaElement\.HAVE_FUTURE_DATA/);
  assert.match(appSource, /function checkBarrierReady/);
  assert.match(appSource, /emitControl\('player:ready'/);
});

test('barrier release schedules one common server-time playback start', () => {
  assert.match(coordinatorSource, /const startAt = Date\.now\(\) \+ this\.startDelayMs/);
  assert.match(coordinatorSource, /reason: 'barrier-release'/);
  assert.match(coordinatorSource, /broadcastBarrier\('starting', \{ startAt, rate: released\.rate \}\)/);

  assert.match(appSource, /function scheduleSynchronizedStart/);
  assert.match(appSource, /startAt - estimatedServerNow\(\)/);
  assert.match(appSource, /state\.scheduledStartTimer = setTimeout/);
});

test('normal playback never changes speed to chase drift', () => {
  assert.match(appSource, /DESYNC_THRESHOLD_SECONDS\s*=\s*2\.5/);
  assert.match(appSource, /DESYNC_SAMPLES\s*=\s*3/);
  assert.match(appSource, /emitControl\('player:desync'/);
  assert.doesNotMatch(appSource, /1\.0[1-9]|0\.9[0-9]/);
  assert.doesNotMatch(appSource, /playbackRate\s*[+\-]=/);
});

test('sustained buffering opens the same readiness barrier instead of auto-resuming', () => {
  assert.match(coordinatorSource, /bufferingDelayMs = Number\(options\.bufferingDelayMs \|\| 1500\)/);
  assert.match(coordinatorSource, /reason: 'buffering'/);
  assert.doesNotMatch(coordinatorSource, /bufferingResumeTimer|room:buffering-resume/);
});

test('late join is explicitly converted into a pause-and-prepare barrier', () => {
  const joinBlock = coordinatorSource.match(/handleJoin\(participantId, nickname\)[\s\S]*?\n\s*unregisterParticipant/)?.[0] || '';
  assert.ok(joinBlock);
  assert.match(joinBlock, /current\.playing/);
  assert.match(joinBlock, /reason: 'join'/);
  assert.match(joinBlock, /beginBarrier\(/);
  assert.match(appSource, /对方加入，已暂停。双方缓存到同一位置后会同时继续播放。/);
});
