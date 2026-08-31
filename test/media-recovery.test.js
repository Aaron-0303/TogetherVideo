const test = require('node:test');
const assert = require('node:assert/strict');
const Recovery = require('../public/media-recovery');

test('pre-first-frame stalls are ignored', () => {
  const tracker = Recovery.createTracker();
  tracker.reset({ preparing: true });
  const stalled = tracker.beginStall({ position: 0, now: 1000 });
  assert.equal(stalled.ignored, true);
  assert.equal(tracker.snapshot().phase, 'preparing');
});

test('real stalls share buffering only after debounce and reload after 12s', () => {
  const tracker = Recovery.createTracker();
  tracker.reset({ preparing: true });
  tracker.markRendered(10);
  tracker.beginStall({ position: 10, now: 1000 });
  assert.equal(tracker.stallStatus(1500).shouldShareBuffering, false);
  assert.equal(tracker.stallStatus(1700).shouldShareBuffering, true);
  assert.equal(tracker.stallStatus(12999).shouldReload, false);
  assert.equal(tracker.stallStatus(13000).shouldReload, true);
});

test('canplay clears shared buffering but keeps sync frozen', () => {
  const tracker = Recovery.createTracker();
  tracker.reset({ preparing: true });
  tracker.markRendered(5);
  tracker.beginStall({ position: 5, now: 1000 });
  const playable = tracker.markPlayable();
  assert.equal(playable.clearSharedBuffering, true);
  assert.equal(tracker.shouldFreezeSync(), true);
  assert.equal(tracker.snapshot().phase, 'recovering');
});

test('recovery needs three seconds of real forward playback', () => {
  const tracker = Recovery.createTracker();
  tracker.reset({ preparing: true });
  tracker.markRendered(10);
  tracker.beginStall({ position: 10, now: 1000 });
  tracker.markPlayable();

  let result = tracker.noteProgress({ position: 10.1, readyState: 4, paused: false, seeking: false, now: 2000 });
  assert.equal(result.phase, 'stabilizing');
  result = tracker.noteProgress({ position: 12.0, readyState: 4, paused: false, seeking: false, now: 4500 });
  assert.equal(result.recovered, false);
  result = tracker.noteProgress({ position: 12.5, readyState: 4, paused: false, seeking: false, now: 5000 });
  assert.equal(result.recovered, true);
  assert.equal(tracker.shouldFreezeSync(), false);
});

test('a seek invalidates the stable-play window', () => {
  const tracker = Recovery.createTracker();
  tracker.reset({ preparing: true });
  tracker.markRendered(20);
  tracker.beginStall({ position: 20, now: 1000 });
  tracker.markPlayable();
  tracker.noteProgress({ position: 20.1, readyState: 4, paused: false, seeking: false, now: 2000 });
  assert.equal(tracker.snapshot().phase, 'stabilizing');
  tracker.invalidateStability();
  assert.equal(tracker.snapshot().phase, 'recovering');
});

test('automatic reload has a finite retry budget', () => {
  const tracker = Recovery.createTracker();
  const delays = [];
  for (let i = 0; i < Recovery.RETRY_DELAYS_MS.length; i += 1) delays.push(tracker.nextRetry().delayMs);
  assert.deepEqual(delays, Recovery.RETRY_DELAYS_MS);
  assert.equal(tracker.nextRetry(), null);
});
