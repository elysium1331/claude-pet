const test = require('node:test');
const assert = require('node:assert/strict');
const { pointerPlan, hitAreaBounds, boundsDiffer } = require('../src/main/click-through');

// The bundled fox lounging on a 1920x1080 display's taskbar, facing right: its body is the bottom 40% of the box,
// x 27.15..144.75 and y 971..1032.28.
const lounging = { top: 0.6, right: 0.195, bottom: 0.017, left: 0.021 };
const petSize = { width: 150, height: 160 };
const petPos = { x: 24, y: 875 };
const plan = (cursor, extra = {}) => pointerPlan({ cursor, petPos, petSize, insets: lounging, ...extra });

test('the hit area covers only the body, in whole pixels', () => {
  assert.deepEqual(hitAreaBounds(petPos, petSize, lounging), { x: 27, y: 971, width: 118, height: 61 });
  // a pose with no body left still gets a window Windows can create
  const flat = hitAreaBounds({ x: 0, y: 0 }, petSize, { top: 0.5, right: 0, bottom: 0.5, left: 0 });
  assert.deepEqual(flat, { x: 0, y: 80, width: 150, height: 1 });
});

test('the see-through margins of the pet box are not the body', () => {
  const margins = [{ x: 100, y: 900 }, { x: 100, y: 970 }, { x: 26, y: 1000 }, { x: 145, y: 1000 }, { x: 100, y: 1032 }];
  for (const cursor of margins) {
    assert.deepEqual(plan(cursor), { overBody: false, hovered: false }, JSON.stringify(cursor));
  }
});

test('the body, where the hit area is, looks hovered', () => {
  for (const cursor of [{ x: 27, y: 971 }, { x: 100, y: 1000 }, { x: 144, y: 1031 }]) {
    assert.deepEqual(plan(cursor), { overBody: true, hovered: true }, JSON.stringify(cursor));
  }
});

test('a press or drag keeps the pet looking hovered even when the cursor leaves the body', () => {
  const held = { overBody: false, hovered: true };
  assert.deepEqual(plan({ x: 100, y: 900 }, { holding: true }), held);
  assert.deepEqual(plan({ x: 5000, y: 5000 }, { holding: true }), held); // pushed past a screen edge the pet can't follow
  assert.deepEqual(plan({ x: 100, y: 1000 }, { holding: true }), { ...held, overBody: true });
});

test('without a cursor position nothing is hovered', () => {
  assert.deepEqual(plan(null), { overBody: false, hovered: false });
});

test('the insets for the side the pet faces decide where its body is', () => {
  const facingLeft = { top: 0.6, right: 0.021, bottom: 0.017, left: 0.195 }; // body starts at x 53.25
  assert.equal(plan({ x: 40, y: 1000 }).overBody, true);
  assert.equal(pointerPlan({ cursor: { x: 40, y: 1000 }, petPos, petSize, insets: facingLeft }).overBody, false);
  assert.equal(hitAreaBounds(petPos, petSize, facingLeft).x, 53);
});

test('boundsDiffer notices a window Windows moved, resized or never placed', () => {
  const wanted = { x: 27, y: 971, width: 118, height: 61 };
  assert.equal(boundsDiffer({ ...wanted }, wanted), false);
  assert.equal(boundsDiffer({ ...wanted, x: 28 }, wanted), true);
  assert.equal(boundsDiffer({ ...wanted, y: 0 }, wanted), true);
  assert.equal(boundsDiffer({ ...wanted, width: 119 }, wanted), true); // e.g. rescaled by a display change
  assert.equal(boundsDiffer({ ...wanted, height: 60 }, wanted), true);
  assert.equal(boundsDiffer(null, wanted), true);
  assert.equal(boundsDiffer({ ...wanted }, null), true);
});
