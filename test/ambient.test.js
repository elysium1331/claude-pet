const test = require('node:test');
const assert = require('node:assert/strict');
const { createAmbient } = require('../src/renderer/ambient');

// small seeded generator so runs are repeatable
function seeded(seed) {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

function run(ambient, fromMs, toMs, stepMs = 16) {
  const frames = [];
  for (let t = fromMs; t <= toMs; t += stepMs) frames.push({ t, ...ambient.step(t) });
  return frames;
}

test('ambient motion stays within -1..1 on every channel', () => {
  const frames = run(createAmbient({ random: seeded(7) }), 0, 60_000);
  for (const f of frames) {
    for (const key of ['earLeft', 'earRight', 'tailSway']) {
      assert.ok(f[key] >= -1 && f[key] <= 1, `${key}=${f[key]} at ${f.t}`);
    }
  }
});

test('ears twitch now and then and settle back to rest in between', () => {
  const frames = run(createAmbient({ random: seeded(42) }), 0, 30_000);
  const twitches = frames.filter((f) => Math.abs(f.earLeft) > 0.3 || Math.abs(f.earRight) > 0.3);
  assert.ok(twitches.length > 0, 'at least one twitch in 30 seconds');
  const resting = frames.filter((f) => Math.abs(f.earLeft) < 0.05 && Math.abs(f.earRight) < 0.05);
  assert.ok(resting.length > frames.length * 0.5, 'ears are at rest most of the time');
});

test('the tail drifts over time instead of staying still', () => {
  const frames = run(createAmbient({ random: seeded(3) }), 0, 30_000);
  const values = frames.map((f) => f.tailSway);
  assert.ok(Math.max(...values) - Math.min(...values) > 0.3);
});

test('different seeds give different motion (it is random, not a fixed loop)', () => {
  const a = run(createAmbient({ random: seeded(1) }), 0, 10_000).map((f) => f.earLeft.toFixed(3)).join();
  const b = run(createAmbient({ random: seeded(2) }), 0, 10_000).map((f) => f.earLeft.toFixed(3)).join();
  assert.notEqual(a, b);
});

test('a tail lift raises the tail while travelling and eases back down after', () => {
  const ambient = createAmbient({ random: seeded(5) });
  const average = (frames) => frames.reduce((sum, f) => sum + f.tailSway, 0) / frames.length;
  const before = average(run(ambient, 0, 10_000));
  ambient.setTailLift(0.6);
  const lifted = run(ambient, 10_016, 20_000);
  assert.ok(average(lifted.slice(-300)) > before + 0.4, 'tail held noticeably higher');
  assert.ok(lifted.every((f) => f.tailSway <= 1), 'still within range');
  ambient.setTailLift(0);
  const after = run(ambient, 20_016, 30_000);
  assert.ok(average(after.slice(-300)) < average(lifted.slice(-300)) - 0.3, 'drops back down');
});

test('calm mode (sleeping) eases everything back to rest', () => {
  const ambient = createAmbient({ random: seeded(9) });
  run(ambient, 0, 20_000);
  ambient.setCalm(true);
  const last = run(ambient, 20_016, 24_000).at(-1);
  assert.ok(Math.abs(last.earLeft) < 0.02 && Math.abs(last.earRight) < 0.02 && Math.abs(last.tailSway) < 0.02);
});
