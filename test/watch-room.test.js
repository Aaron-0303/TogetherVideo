const test = require('node:test');
const assert = require('node:assert/strict');
const { WatchRoom } = require('../src/watch-room');

test('single room rejects stale media events', () => {
  const room = new WatchRoom();
  const first = room.apply('select', { mediaPath: 'show/ep1.mp4', mediaName: 'ep1.mp4' }, 'A');
  const oldVersion = first.mediaVersion;
  const second = room.apply('select', { mediaPath: 'show/ep2.mp4', mediaName: 'ep2.mp4' }, 'B');
  const stale = room.apply('play', { mediaPath: 'show/ep1.mp4', mediaVersion: oldVersion, position: 20 }, 'A');
  assert.equal(stale, null);
  const current = room.snapshot();
  assert.equal(current.media.path, 'show/ep2.mp4');
  assert.equal(current.mediaVersion, second.mediaVersion);
  assert.equal(current.playing, false);
});

test('wait pauses the authoritative timeline', () => {
  const room = new WatchRoom();
  const selected = room.apply('select', { mediaPath: 'movie.mp4' }, 'A');
  room.apply('play', { mediaPath: 'movie.mp4', mediaVersion: selected.mediaVersion, position: 12 }, 'A');
  const paused = room.apply('wait', {}, 'B');
  assert.equal(paused.playing, false);
  assert.ok(paused.position >= 12);
  assert.equal(paused.reason, 'wait');
});

test('scheduled play does not advance before the shared startAt', () => {
  const room = new WatchRoom();
  const selected = room.apply('select', { mediaPath: 'movie.mp4' }, 'A');
  const now = Date.now();
  const startAt = now + 1000;
  const started = room.apply('play', {
    mediaPath: 'movie.mp4',
    mediaVersion: selected.mediaVersion,
    position: 30,
    startAt,
    reason: 'barrier-release',
  }, '同步开始');

  assert.equal(started.playing, true);
  assert.ok(started.startAt >= startAt - 5);
  const before = room.snapshot(now + 500);
  assert.ok(Math.abs(before.position - 30) < 0.01);
  const after = room.snapshot(now + 1500);
  assert.ok(after.position >= 30.45 && after.position <= 30.55);
});

test('rate change keeps the same media version', () => {
  const room = new WatchRoom();
  const selected = room.apply('select', { mediaPath: 'movie.mp4' }, 'A');
  const changed = room.apply('rate', { mediaPath: 'movie.mp4', mediaVersion: selected.mediaVersion, rate: 1.5 }, 'B');
  assert.equal(changed.rate, 1.5);
  assert.equal(changed.mediaVersion, selected.mediaVersion);
});

test('only explicit menu playback rates can become authoritative room rates', () => {
  const room = new WatchRoom();
  const selected = room.apply('select', { mediaPath: 'movie.mp4' }, 'A');
  const leakedFast = room.apply('rate', { mediaPath: 'movie.mp4', mediaVersion: selected.mediaVersion, rate: 1.012 }, 'A');
  const leakedSlow = room.apply('rate', { mediaPath: 'movie.mp4', mediaVersion: selected.mediaVersion, rate: 0.99 }, 'B');
  assert.equal(leakedFast, null);
  assert.equal(leakedSlow, null);
  assert.equal(room.snapshot().rate, 1);
});
