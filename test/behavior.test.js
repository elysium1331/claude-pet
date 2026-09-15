const test = require('node:test');
const assert = require('node:assert/strict');
const {
  insetsForState, gotUp, wokeUp, wakeReaction, fidgetsFor, lookFromCursor, usageEvents, shouldGreet, restingPose,
  isNightTime, resolveState, usageRose,
} = require('../src/main/behavior');
const { parseUsage } = require('../src/main/usage-parse');

test('resolveState falls back to the closest pose a pet file actually has', () => {
  const fox = { states: { idle: 0, sleeping: 1, working: 2, needsAttention: 3, chasing: 12, sitting: 13 } };
  assert.equal(resolveState(fox, 'sitting'), 'sitting');
  assert.equal(resolveState(fox, 'walking'), 'chasing');
  assert.equal(resolveState(fox, 'floatingTravel'), 'chasing');
  assert.equal(resolveState(fox, 'lounging'), 'sleeping');
  assert.equal(resolveState({ states: { idle: 0, walking: 14 } }, 'walking'), 'walking');
  assert.equal(resolveState({ states: { idle: 0 } }, 'walking'), 'idle');
});

test('isNightTime handles windows that wrap past midnight', () => {
  const at = (h, m = 0) => new Date(2026, 8, 14, h, m);
  assert.equal(isNightTime(at(23), 22, 7), true);
  assert.equal(isNightTime(at(3), 22, 7), true);
  assert.equal(isNightTime(at(7), 22, 7), false);
  assert.equal(isNightTime(at(12), 22, 7), false);
  assert.equal(isNightTime(at(21, 59), 22, 7), false);
  // a window that doesn't wrap
  assert.equal(isNightTime(at(2), 1, 5), true);
  assert.equal(isNightTime(at(6), 1, 5), false);
});

test('restingPose sits on the taskbar instead of floating, when the pet can sit', () => {
  const sitter = { states: { idle: 0, sitting: 13 } };
  assert.equal(restingPose(sitter, 'idle', true), 'sitting');
  assert.equal(restingPose(sitter, 'idle', false), 'idle');
  assert.equal(restingPose(sitter, 'lowUsage', true), 'lowUsage');
  assert.equal(restingPose({ states: { idle: 0 } }, 'idle', true), 'idle');
  // the user can prefer floating (normal size) on the taskbar
  assert.equal(restingPose(sitter, 'idle', true, 'float'), 'idle');
  assert.equal(restingPose(sitter, 'idle', true, 'sit'), 'sitting');
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

test('insetsForState picks the bounds for the direction the pet faces, when the pet provides both', () => {
  const right = { top: 0.1, right: 0.2, bottom: 0.1, left: 0.05 };
  const left = { top: 0.1, right: 0.3, bottom: 0.1, left: 0.05 };
  const turner = { bodyInsets: { right, left }, stateInsets: { lounging: { right: left, left: right } } };
  assert.deepEqual(insetsForState(turner, 'idle', 1), right);
  assert.deepEqual(insetsForState(turner, 'idle', -1), left);
  assert.deepEqual(insetsForState(turner, 'lounging', -1), right);
  // pets with one set of bounds ignore facing
  assert.deepEqual(insetsForState(pet, 'idle', -1), pet.bodyInsets);
});

test('wakeReaction plays the wake-up only when leaving a resting pose', () => {
  assert.equal(wakeReaction(pet, 'lounging', 'idle'), 'perkUp');
  assert.equal(wakeReaction(pet, 'sleeping', 'lowUsage'), 'perkUp');
  assert.equal(wakeReaction(pet, 'sleeping', 'lounging'), null);
  assert.equal(wakeReaction(pet, 'idle', 'lounging'), null);
  assert.equal(wakeReaction(pet, 'idle', 'lowUsage'), null);
  assert.equal(wakeReaction({}, 'lounging', 'idle'), null); // pet without a wake animation
});

test('gotUp is true only when the pet leaves a resting pose', () => {
  assert.equal(gotUp('sleeping', 'idle'), true);
  assert.equal(gotUp('lounging', 'working'), true);
  assert.equal(gotUp('sleeping', 'lounging'), false);
  assert.equal(gotUp('idle', 'working'), false);
  assert.equal(gotUp('idle', 'sleeping'), false);
});

test('wokeUp is true whenever the pet leaves sleep, even to lie down awake', () => {
  assert.equal(wokeUp('sleeping', 'idle'), true);
  assert.equal(wokeUp('sleeping', 'lounging'), true); // a lounging pet can still wave hello
  assert.equal(wokeUp('lounging', 'idle'), false);
  assert.equal(wokeUp('idle', 'sleeping'), false);
  assert.equal(wokeUp('sleeping', 'sleeping'), false);
});

test('fidgetsFor only offers fidgets that fit the current pose (idle by default)', () => {
  assert.deepEqual(fidgetsFor(pet, 'idle').map((f) => f.trigger), ['lookAround', 'stretch', 'yawn']);
  assert.deepEqual(fidgetsFor(pet, 'lounging').map((f) => f.trigger), ['lookAround', 'yawn']);
  assert.deepEqual(fidgetsFor(pet, 'sleeping'), []);
  assert.deepEqual(fidgetsFor({}, 'idle'), []);
});

const meters = (session, weekly, fable) => ({
  session: { id: 'session', percent: session },
  weekly: { id: 'weekly', percent: weekly },
  scoped: [{ id: 'scoped:Fable', label: 'Fable', percent: fable }],
});

test('usage events compare each scoped meter with its own previous value, even when names repeat', () => {
  const unnamed = (a, b) => parseUsage({ limits: [{ kind: 'weekly_scoped', percent: a, scope: null }, { kind: 'weekly_scoped', percent: b, scope: {} }] });
  assert.deepEqual(usageEvents(unnamed(50, 100), unnamed(50, 100)), []);
  assert.equal(usageRose(unnamed(10, 40), unnamed(10, 40)), false);
  const opus = (code, chat) => parseUsage({
    limits: [
      { kind: 'weekly_scoped', percent: code, scope: { model: 'Opus', surface: 'code' } },
      { kind: 'weekly_scoped', percent: chat, scope: { model: 'Opus', surface: 'chat' } },
    ],
  });
  assert.deepEqual(usageEvents(opus(40, 10), opus(40, 10)), []);
  assert.deepEqual(usageEvents(opus(40, 99), opus(40, 100)), ['limitHit']);
});

test('a meter with an unknown percent never counts as a reset or as usage going up', () => {
  const session = (percent) => ({ session: { id: 'session', percent }, weekly: null, scoped: [] });
  assert.deepEqual(usageEvents(session(85), session(null)), []);
  assert.equal(usageRose(session(null), session(85)), false);
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

test('usageRose notices Claude being used anywhere (chat included) from usage going up', () => {
  assert.equal(usageRose(null, meters(10, 20, 30)), false); // first check: nothing to compare
  assert.equal(usageRose(meters(10, 20, 30), meters(10, 20, 30)), false);
  assert.equal(usageRose(meters(10, 20, 30), meters(11, 20, 30)), true);
  assert.equal(usageRose(meters(10, 20, 30), meters(10, 20, 31)), true);
  assert.equal(usageRose(meters(80, 20, 30), meters(2, 21, 30)), true); // weekly still rose
  assert.equal(usageRose(meters(80, 20, 30), meters(2, 20, 30)), false); // a reset alone isn't use
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
