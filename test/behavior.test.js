const test = require('node:test');
const assert = require('node:assert/strict');
const {
  insetsForState, wakeReaction, fidgetsFor, lookFromCursor, usageEvents, shouldGreet, restingPose,
} = require('../src/main/behavior');

test('restingPose sits on the taskbar instead of floating, when the pet can sit', () => {
  const sitter = { states: { idle: 0, sitting: 13 } };
  assert.equal(restingPose(sitter, 'idle', true), 'sitting');
  assert.equal(restingPose(sitter, 'idle', false), 'idle');
  assert.equal(restingPose(sitter, 'lowUsage', true), 'lowUsage');
  assert.equal(restingPose({ states: { idle: 0 } }, 'idle', true), 'idle');
});

const pet = {
  bodyInsets: { top: 0.045, right: 0.118, bottom: 0.078, left: 0.118 },
  stateInsets: { lounging: { top: 0.658, right: 0.195, bottom: 0.017, left: 0.014 } },
  reactions: { wake: 'perkUp' },
  fidgets: [
    { trigger: 'lookAround', ms: 3000, states: ['idle', 'lounging'] },
    { trigger: 'stretch', ms: 3000 },
    { trigger: 'yawn', ms: 2500, states: ['idle', 'lounging'] },
  ],
};

test('insetsForState uses a pose-specific body box when the pet has one', () => {
  assert.deepEqual(insetsForState(pet, 'lounging'), pet.stateInsets.lounging);
  assert.deepEqual(insetsForState(pet, 'idle'), pet.bodyInsets);
  assert.deepEqual(insetsForState({ bodyInsets: pet.bodyInsets }, 'lounging'), pet.bodyInsets);
});

test('wakeReaction plays the wake-up only when leaving a resting pose', () => {
  assert.equal(wakeReaction(pet, 'lounging', 'idle'), 'perkUp');
  assert.equal(wakeReaction(pet, 'sleeping', 'lowUsage'), 'perkUp');
  assert.equal(wakeReaction(pet, 'sleeping', 'lounging'), null);
  assert.equal(wakeReaction(pet, 'idle', 'lounging'), null);
  assert.equal(wakeReaction(pet, 'idle', 'lowUsage'), null);
  assert.equal(wakeReaction({}, 'lounging', 'idle'), null); // pet without a wake animation
});

test('fidgetsFor only offers fidgets that fit the current pose (idle by default)', () => {
  assert.deepEqual(fidgetsFor(pet, 'idle').map((f) => f.trigger), ['lookAround', 'stretch', 'yawn']);
  assert.deepEqual(fidgetsFor(pet, 'lounging').map((f) => f.trigger), ['lookAround', 'yawn']);
  assert.deepEqual(fidgetsFor(pet, 'sleeping'), []);
  assert.deepEqual(fidgetsFor({}, 'idle'), []);
});

const meters = (session, weekly, fable) => ({
  session: { percent: session },
  weekly: { percent: weekly },
  scoped: [{ label: 'Fable', percent: fable }],
});

test('usageEvents spots a limit resetting and a limit being hit', () => {
  assert.deepEqual(usageEvents(null, meters(10, 20, 30)), []); // first load: nothing to compare
  assert.deepEqual(usageEvents(meters(10, 20, 30), meters(12, 21, 30)), []); // normal use
  assert.deepEqual(usageEvents(meters(84, 40, 30), meters(3, 40, 30)), ['usageReset']); // session reset
  assert.deepEqual(usageEvents(meters(20, 99, 60), meters(20, 100, 60)), ['limitHit']);
  assert.deepEqual(usageEvents(meters(20, 100, 60), meters(20, 100, 60)), []); // already at the limit
  // a reset wins if both happen in the same check
  assert.deepEqual(usageEvents(meters(90, 99, 60), meters(2, 100, 60)), ['usageReset']);
  // small drops (rounding / data wobble) are not a reset
  assert.deepEqual(usageEvents(meters(30, 40, 50), meters(22, 40, 50)), []);
});

test('shouldGreet says hello once per day', () => {
  const now = new Date(2026, 8, 14, 9, 30);
  assert.equal(shouldGreet(null, now), true);
  assert.equal(shouldGreet('2026-09-13', now), true);
  assert.equal(shouldGreet('2026-09-14', now), false);
});

test('lookFromCursor points the eyes at the cursor, mirrored when the art is flipped', () => {
  const center = { x: 1000, y: 800 };
  assert.deepEqual(lookFromCursor({ cursor: { x: 1225, y: 800 }, center }), { x: 0.5, y: 0 });
  assert.deepEqual(lookFromCursor({ cursor: { x: 0, y: 0 }, center }), { x: -1, y: -1 });
  assert.deepEqual(lookFromCursor({ cursor: { x: 1225, y: 1025 }, center, flipped: true }), { x: -0.5, y: 0.5 });
});
