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

test('rate change keeps the same media version', () => {
  const room = new WatchRoom();
  const selected = room.apply('select', { mediaPath: 'movie.mp4' }, 'A');
  const changed = room.apply('rate', { mediaPath: 'movie.mp4', mediaVersion: selected.mediaVersion, rate: 1.5 }, 'B');
  assert.equal(changed.rate, 1.5);
  assert.equal(changed.mediaVersion, selected.mediaVersion);
});
