const test = require('node:test');
const assert = require('node:assert/strict');
const { pointerPlan } = require('../src/main/click-through');

// The bundled fox lounging on a 1920x1080 display's taskbar, facing right: its body is the bottom 40% of the box,
// x 27.15..144.75 and y 971..1032.28.
const lounging = { top: 0.6, right: 0.195, bottom: 0.017, left: 0.021 };
const petSize = { width: 150, height: 160 };
const petPos = { x: 24, y: 875 };
const plan = (cursor, extra = {}) => pointerPlan({ cursor, petPos, petSize, insets: lounging, ...extra });

test('the see-through margins of the pet box let clicks through to the window below', () => {
  const margins = [{ x: 100, y: 900 }, { x: 100, y: 969 }, { x: 26, y: 1000 }, { x: 160, y: 1000 }, { x: 100, y: 1034 }];
  for (const cursor of margins) {
    assert.deepEqual(plan(cursor), { overBody: false, hovered: false, clickThrough: true }, JSON.stringify(cursor));
  }
});

test('the body takes the mouse', () => {
  for (const cursor of [{ x: 28, y: 972 }, { x: 100, y: 1000 }, { x: 144, y: 1032 }]) {
    assert.deepEqual(plan(cursor), { overBody: true, hovered: true, clickThrough: false }, JSON.stringify(cursor));
  }
});

test('a press or drag keeps the mouse on the pet even when the cursor leaves the body', () => {
  const held = { overBody: false, hovered: true, clickThrough: false };
  assert.deepEqual(plan({ x: 100, y: 900 }, { holding: true }), held);
  assert.deepEqual(plan({ x: 5000, y: 5000 }, { holding: true }), held); // pushed past a screen edge the pet can't follow
  assert.deepEqual(plan({ x: 100, y: 1000 }, { holding: true }), { ...held, overBody: true });
});

test('without a cursor position the whole box is click-through', () => {
  assert.deepEqual(plan(null), { overBody: false, hovered: false, clickThrough: true });
});

test('the insets for the side the pet faces decide where its body is', () => {
  const facingLeft = { top: 0.6, right: 0.021, bottom: 0.017, left: 0.195 }; // body starts at x 53.25
  assert.equal(plan({ x: 40, y: 1000 }).overBody, true);
  assert.equal(pointerPlan({ cursor: { x: 40, y: 1000 }, petPos, petSize, insets: facingLeft }).overBody, false);
});
