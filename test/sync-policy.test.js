const test = require('node:test');
const assert = require('node:assert/strict');
const { Reconciler } = require('../public/sync-policy');

test('RTT estimator ignores one large queueing spike', () => {
  const sync = new Reconciler();
  [60, 64, 58, 420, 62, 61].forEach((value) => sync.sampleRtt(value));
  assert.ok(sync.halfRttMs() >= 29 && sync.halfRttMs() <= 33);
});

test('sub-400ms drift stays in the dead band', () => {
  const sync = new Reconciler();
  const result = sync.decide({ drift: -0.35, desiredRate: 1, playing: true, sampled: true });
  assert.equal(result.action, 'normal');
  assert.equal(result.rate, 1);
});

test('soft correction starts after two persistent samples', () => {
  const sync = new Reconciler();
  assert.equal(sync.decide({ drift: -0.9, desiredRate: 1, playing: true, sampled: true }).action, 'observe');
  const second = sync.decide({ drift: -1.0, desiredRate: 1, playing: true, sampled: true });
  assert.equal(second.action, 'rate');
  assert.ok(second.rate > 1.03 && second.rate < 1.05);
});

test('active soft correction keeps one steady playback rate instead of retuning every sample', () => {
  const sync = new Reconciler();
  sync.decide({ drift: -1.0, desiredRate: 1, playing: true, sampled: true });
  const started = sync.decide({ drift: -1.0, desiredRate: 1, playing: true, sampled: true });
  const later = sync.decide({ drift: -0.72, desiredRate: 1, playing: true, sampled: true });
  const almostSettled = sync.decide({ drift: -0.31, desiredRate: 1, playing: true, sampled: true });
  assert.equal(started.action, 'rate');
  assert.equal(later.action, 'rate');
  assert.equal(almostSettled.action, 'rate');
  assert.equal(later.rate, started.rate);
  assert.equal(almostSettled.rate, started.rate);
});

test('positive and negative drift corrections are symmetric', () => {
  const behind = new Reconciler();
  behind.decide({ drift: -1, desiredRate: 1, playing: true, sampled: true });
  const speedUp = behind.decide({ drift: -1, desiredRate: 1, playing: true, sampled: true });

  const ahead = new Reconciler();
  ahead.decide({ drift: 1, desiredRate: 1, playing: true, sampled: true });
  const slowDown = ahead.decide({ drift: 1, desiredRate: 1, playing: true, sampled: true });

  assert.equal(speedUp.action, 'rate');
  assert.equal(slowDown.action, 'rate');
  assert.ok(Math.abs((speedUp.rate - 1) - (1 - slowDown.rate)) < 1e-9);
});

test('active correction continues below soft threshold until settled', () => {
  const sync = new Reconciler();
  sync.decide({ drift: -0.8, desiredRate: 1, playing: true, sampled: true });
  sync.decide({ drift: -0.8, desiredRate: 1, playing: true, sampled: true });
  const stillCorrecting = sync.decide({ drift: -0.3, desiredRate: 1, playing: true, sampled: true });
  assert.equal(stillCorrecting.action, 'rate');
  const settled = sync.decide({ drift: -0.18, desiredRate: 1, playing: true, sampled: true });
  assert.equal(settled.action, 'normal');
  assert.equal(settled.rate, 1);
});

test('a direction flip stops active correction instead of oscillating', () => {
  const sync = new Reconciler();
  sync.decide({ drift: -1, desiredRate: 1, playing: true, sampled: true });
  sync.decide({ drift: -1, desiredRate: 1, playing: true, sampled: true });
  const flipped = sync.decide({ drift: 0.3, desiredRate: 1, playing: true, sampled: true });
  assert.equal(flipped.action, 'normal');
  assert.equal(flipped.rate, 1);
});

test('hard seek needs three persistent large samples and respects cooldown', () => {
  const sync = new Reconciler();
  const now = 100000;
  sync.decide({ drift: -3.5, desiredRate: 1, playing: true, sampled: true, now });
  const second = sync.decide({ drift: -3.6, desiredRate: 1, playing: true, sampled: true, now: now + 1000 });
  assert.equal(second.action, 'rate');
  const seek = sync.decide({ drift: -3.7, desiredRate: 1, playing: true, sampled: true, now: now + 2000 });
  assert.equal(seek.action, 'seek');

  sync.decide({ drift: -4, desiredRate: 1, playing: true, sampled: true, now: now + 3000 });
  const duringCooldown = sync.decide({ drift: -4, desiredRate: 1, playing: true, sampled: true, now: now + 4000 });
  assert.equal(duringCooldown.action, 'rate');
});

test('buffer recovery suppresses correction before grace period expires', () => {
  const sync = new Reconciler();
  sync.setBuffering(true, 1000);
  sync.setBuffering(false, 2000);
  const early = sync.decide({ drift: -2, desiredRate: 1, playing: true, sampled: true, now: 4000 });
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
