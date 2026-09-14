const test = require('node:test');
const assert = require('node:assert/strict');
const { insetsForState, wakeReaction, fidgetsFor, lookFromCursor } = require('../src/main/behavior');

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

test('lookFromCursor points the eyes at the cursor, mirrored when the art is flipped', () => {
  const center = { x: 1000, y: 800 };
  assert.deepEqual(lookFromCursor({ cursor: { x: 1225, y: 800 }, center }), { x: 0.5, y: 0 });
  assert.deepEqual(lookFromCursor({ cursor: { x: 0, y: 0 }, center }), { x: -1, y: -1 });
  assert.deepEqual(lookFromCursor({ cursor: { x: 1225, y: 1025 }, center, flipped: true }), { x: -0.5, y: 0.5 });
});
