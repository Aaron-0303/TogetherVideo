const test = require('node:test');
const assert = require('node:assert/strict');
const { Reconciler } = require('../public/sync-policy');

test('RTT estimator ignores one large queueing spike', () => {
  const sync = new Reconciler();
  [60, 64, 58, 420, 62, 61].forEach((value) => sync.sampleRtt(value));
  assert.ok(sync.halfRttMs() >= 29 && sync.halfRttMs() <= 33);
});

test('small drift is observed without changing playback', () => {
  const sync = new Reconciler();
  const result = sync.decide({ drift: -0.9, desiredRate: 1, playing: true, sampled: true });
  assert.equal(result.action, 'normal');
  assert.equal(result.rate, 1);
});

test('soft correction requires persistent same-direction drift', () => {
  const sync = new Reconciler();
  assert.equal(sync.decide({ drift: -1.8, desiredRate: 1, playing: true, sampled: true }).action, 'observe');
  assert.equal(sync.decide({ drift: -1.9, desiredRate: 1, playing: true, sampled: true }).action, 'observe');
  const third = sync.decide({ drift: -1.7, desiredRate: 1, playing: true, sampled: true });
  assert.equal(third.action, 'rate');
  assert.equal(third.rate, 1.02);
});

test('a direction flip resets drift hysteresis', () => {
  const sync = new Reconciler();
  sync.decide({ drift: -2, desiredRate: 1, playing: true, sampled: true });
  sync.decide({ drift: -2.1, desiredRate: 1, playing: true, sampled: true });
  const flipped = sync.decide({ drift: 2, desiredRate: 1, playing: true, sampled: true });
  assert.equal(flipped.action, 'observe');
  assert.equal(flipped.stableSamples, 1);
});

test('hard seek needs persistent large drift and respects cooldown', () => {
  const sync = new Reconciler();
  const now = 100000;
  sync.decide({ drift: -4, desiredRate: 1, playing: true, sampled: true, now });
  sync.decide({ drift: -4.1, desiredRate: 1, playing: true, sampled: true, now: now + 1000 });
  const seek = sync.decide({ drift: -4.2, desiredRate: 1, playing: true, sampled: true, now: now + 2000 });
  assert.equal(seek.action, 'seek');
  sync.decide({ drift: -5, desiredRate: 1, playing: true, sampled: true, now: now + 3000 });
  sync.decide({ drift: -5, desiredRate: 1, playing: true, sampled: true, now: now + 4000 });
  const cooldown = sync.decide({ drift: -5, desiredRate: 1, playing: true, sampled: true, now: now + 5000 });
  assert.equal(cooldown.action, 'rate');
});

test('buffer recovery suppresses correction before grace period expires', () => {
  const sync = new Reconciler();
  sync.setBuffering(true, 1000);
  sync.setBuffering(false, 2000);
  const early = sync.decide({ drift: -4, desiredRate: 1, playing: true, sampled: true, now: 5000 });
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
