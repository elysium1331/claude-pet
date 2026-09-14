const test = require('node:test');
const assert = require('node:assert/strict');
const { newLife, decay, reward, levelForXp, LEVEL_XP } = require('../src/main/pet-life');

const HOUR = 3_600_000;
const t0 = new Date(2026, 8, 14, 9, 0).getTime();

test('a new pet starts content at level 0', () => {
  const life = newLife(t0);
  assert.equal(life.happiness, 60);
  assert.equal(life.xp, 0);
  assert.equal(life.level, 0);
});

test('happiness slowly fades when the pet is ignored, but never below 20', () => {
  const life = newLife(t0);
  assert.equal(decay(life, t0 + 3 * HOUR).happiness, 54);
  assert.equal(decay(life, t0 + 100 * HOUR).happiness, 20);
  // decay doesn't double count
  const once = decay(life, t0 + 3 * HOUR);
  assert.equal(decay(once, t0 + 3 * HOUR).happiness, 54);
});

test('reward raises happiness (capped at 100) and xp', () => {
  let { life } = reward(newLife(t0), 'petted', t0);
  assert.equal(life.happiness, 66);
  assert.equal(life.xp, 1);
  for (let i = 0; i < 20; i += 1) ({ life } = reward(life, 'fed', t0 + i * HOUR));
  assert.equal(life.happiness, 100);
});

test('feeding again too soon is allowed but not rewarded', () => {
  let result = reward(newLife(t0), 'fed', t0);
  assert.equal(result.rewarded, true);
  result = reward(result.life, 'fed', t0 + 5 * 60_000);
  assert.equal(result.rewarded, false);
  assert.equal(result.life.xp, 2);
  result = reward(result.life, 'fed', t0 + 25 * 60_000);
  assert.equal(result.rewarded, true);
});

test('play xp is capped per day so it cannot be farmed; Claude tasks are not capped', () => {
  let life = newLife(t0);
  for (let i = 0; i < 100; i += 1) ({ life } = reward(life, 'petted', t0 + i * 1000));
  assert.equal(life.xp, 30);
  ({ life } = reward(life, 'taskDone', t0 + 200_000));
  assert.equal(life.xp, 33);
  // next day the play cap resets
  ({ life } = reward(life, 'petted', t0 + 24 * HOUR));
  assert.equal(life.xp, 34);
});

test('levels come from xp thresholds and report when the pet levels up', () => {
  assert.deepEqual(LEVEL_XP, [0, 30, 120, 300]);
  assert.equal(levelForXp(0), 0);
  assert.equal(levelForXp(29), 0);
  assert.equal(levelForXp(30), 1);
  assert.equal(levelForXp(500), 3);

  let life = { ...newLife(t0), xp: 28 };
  let result = reward(life, 'taskDone', t0);
  assert.equal(result.life.level, 1);
  assert.equal(result.leveledUp, true);
  result = reward(result.life, 'taskDone', t0 + 1000);
  assert.equal(result.leveledUp, false);
});
