const test = require('node:test');
const assert = require('node:assert/strict');
const { Reconciler } = require('../public/sync-policy');

test('RTT estimator ignores one large queueing spike', () => {
  const sync = new Reconciler();
  [60, 64, 58, 420, 62, 61].forEach((value) => sync.sampleRtt(value));
  assert.ok(sync.halfRttMs() >= 29 && sync.halfRttMs() <= 33);
});

test('small drift stays untouched for viewing comfort', () => {
  const sync = new Reconciler();
  const result = sync.decide({ drift: -0.55, desiredRate: 1, playing: true, sampled: true, now: 1000 });
  assert.equal(result.action, 'normal');
  assert.equal(result.rate, 1);
  assert.equal(result.reason, 'within-comfort-zone');
});

test('moderate sub-threshold drift is observed without changing playback rate', () => {
  const sync = new Reconciler();
  for (let i = 0; i < 5; i += 1) {
    const result = sync.decide({ drift: -1.1, desiredRate: 1, playing: true, sampled: true, now: 1000 + i * 1000 });
    assert.equal(result.action, 'normal');
    assert.equal(result.rate, 1);
  }
});

test('soft correction starts only after three persistent samples', () => {
  const sync = new Reconciler();
  const first = sync.decide({ drift: -1.6, desiredRate: 1, playing: true, sampled: true, now: 1000 });
  const second = sync.decide({ drift: -1.7, desiredRate: 1, playing: true, sampled: true, now: 2000 });
  const third = sync.decide({ drift: -1.8, desiredRate: 1, playing: true, sampled: true, now: 3000 });
  assert.equal(first.action, 'observe');
  assert.equal(second.action, 'observe');
  assert.equal(third.action, 'rate');
  assert.ok(third.rate > 1.01 && third.rate <= 1.03);
});

test('active correction keeps one steady subtle rate instead of retuning every sample', () => {
  const sync = new Reconciler();
  sync.decide({ drift: -1.8, desiredRate: 1, playing: true, sampled: true, now: 1000 });
  sync.decide({ drift: -1.8, desiredRate: 1, playing: true, sampled: true, now: 2000 });
  const started = sync.decide({ drift: -1.8, desiredRate: 1, playing: true, sampled: true, now: 3000 });
  const later = sync.decide({ drift: -1.25, desiredRate: 1, playing: true, sampled: true, now: 4000 });
  const closer = sync.decide({ drift: -0.7, desiredRate: 1, playing: true, sampled: true, now: 5000 });
  assert.equal(started.action, 'rate');
  assert.equal(later.action, 'rate');
  assert.equal(closer.action, 'rate');
  assert.equal(later.rate, started.rate);
  assert.equal(closer.rate, started.rate);
  assert.ok(Math.abs(started.rate - 1) <= 0.03);
});

test('correction ends once robust drift is settled', () => {
  const sync = new Reconciler({ driftWindow: 3 });
  sync.decide({ drift: -1.8, desiredRate: 1, playing: true, sampled: true, now: 1000 });
  sync.decide({ drift: -1.8, desiredRate: 1, playing: true, sampled: true, now: 2000 });
  sync.decide({ drift: -1.8, desiredRate: 1, playing: true, sampled: true, now: 3000 });
  sync.decide({ drift: -0.2, desiredRate: 1, playing: true, sampled: true, now: 4000 });
  sync.decide({ drift: -0.15, desiredRate: 1, playing: true, sampled: true, now: 5000 });
  const settled = sync.decide({ drift: -0.1, desiredRate: 1, playing: true, sampled: true, now: 6000 });
  assert.equal(settled.action, 'normal');
  assert.equal(settled.rate, 1);
});

test('a direction flip stops active correction instead of oscillating', () => {
  const sync = new Reconciler({ driftWindow: 3 });
  sync.decide({ drift: -1.8, desiredRate: 1, playing: true, sampled: true, now: 1000 });
  sync.decide({ drift: -1.8, desiredRate: 1, playing: true, sampled: true, now: 2000 });
  sync.decide({ drift: -1.8, desiredRate: 1, playing: true, sampled: true, now: 3000 });
  sync.decide({ drift: 0.8, desiredRate: 1, playing: true, sampled: true, now: 4000 });
  const flipped = sync.decide({ drift: 0.8, desiredRate: 1, playing: true, sampled: true, now: 5000 });
  assert.notEqual(flipped.action, 'rate');
});

test('major desync seeks only after two persistent 4s samples', () => {
  const sync = new Reconciler();
  const first = sync.decide({ drift: -4.4, desiredRate: 1, playing: true, sampled: true, now: 100000 });
  const second = sync.decide({ drift: -4.5, desiredRate: 1, playing: true, sampled: true, now: 101000 });
  assert.notEqual(first.action, 'seek');
  assert.equal(second.action, 'seek');
  assert.equal(second.reason, 'major-desync');
});

test('rapidly growing drift is treated as abnormal rate state, not chased with more speed', () => {
  const sync = new Reconciler();
  const samples = [-1.0, -1.2, -1.4, -1.7];
  let result;
  samples.forEach((drift, index) => {
    result = sync.decide({ drift, desiredRate: 1, playing: true, sampled: true, now: 100000 + index * 1000 });
  });
  assert.equal(result.action, 'seek');
  assert.equal(result.reason, 'runaway');
  assert.ok(result.growthPerSecond >= 0.08);
});

test('soft correction has a maximum duration and returns to normal rate', () => {
  const sync = new Reconciler({ maxCorrectionDurationMs: 3000, correctionCooldownMs: 5000 });
  sync.decide({ drift: -1.8, desiredRate: 1, playing: true, sampled: true, now: 1000 });
  sync.decide({ drift: -1.8, desiredRate: 1, playing: true, sampled: true, now: 2000 });
  const started = sync.decide({ drift: -1.8, desiredRate: 1, playing: true, sampled: true, now: 3000 });
  const timeout = sync.decide({ drift: -1.6, desiredRate: 1, playing: true, sampled: true, now: 6001 });
  assert.equal(started.action, 'rate');
  assert.equal(timeout.action, 'normal');
  assert.equal(timeout.rate, 1);
  assert.equal(timeout.reason, 'correction-timeout');
});

test('buffer recovery suppresses correction before grace period expires', () => {
  const sync = new Reconciler();
  sync.setBuffering(true, 1000);
  sync.setBuffering(false, 2000);
  const early = sync.decide({ drift: -2, desiredRate: 1, playing: true, sampled: true, now: 5000 });
  assert.equal(early.action, 'observe');
  assert.equal(early.rate, 1);
});

test('buffering viewer holds position when the room pauses', () => {
  const sync = new Reconciler();
  sync.setBuffering(true, 1000);
  const paused = sync.decide({
    drift: -3.2,
    desiredRate: 1,
    playing: false,
    buffering: true,
    sampled: false,
    reason: 'wait',
    now: 2000,
  });
  assert.equal(paused.action, 'hold');
  assert.equal(paused.rate, 1);
});

test('manual sync is always allowed to seek precisely', () => {
  const sync = new Reconciler();
  const result = sync.decide({ drift: -0.9, desiredRate: 1, playing: true, sampled: true, force: true, now: 1000 });
  assert.equal(result.action, 'seek');
  assert.equal(result.reason, 'manual');
});
