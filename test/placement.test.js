const test = require('node:test');
const assert = require('node:assert/strict');
const {
  clampPet, panelPlacement, chooseFacing, mirrorInsets, scaledPetSize, resizeAnchored, positionChanged,
} = require('../src/main/placement');

test('scaledPetSize scales the pet box and keeps the scale sensible', () => {
  assert.deepEqual(scaledPetSize(1), { width: 150, height: 160 });
  assert.deepEqual(scaledPetSize(1.25), { width: 188, height: 200 });
  assert.deepEqual(scaledPetSize(0.8), { width: 120, height: 128 });
  assert.deepEqual(scaledPetSize(9), scaledPetSize(2));
  assert.deepEqual(scaledPetSize('nonsense'), { width: 150, height: 160 });
});

test('resizeAnchored keeps the bottom center in place so the pet stays on the taskbar', () => {
  const before = { x: 100, y: 900 };
  const after = resizeAnchored(before, { width: 150, height: 160 }, { width: 188, height: 200 });
  assert.deepEqual(after, { x: 81, y: 860 });
  // bottom center unchanged: 100+75 = 81+94, 900+160 = 860+200
});

// 1920x1080 display with a 48px taskbar at the bottom.
const workArea = { x: 0, y: 0, width: 1920, height: 1032 };
const petSize = { width: 150, height: 160 };
// Visible body starts 10% in from the left/right/top and 20% up from the bottom of the pet box.
const insets = { top: 0.1, right: 0.1, bottom: 0.2, left: 0.1 };
const opts = { petSize, insets, workArea, snapPx: 24 };

test('clampPet leaves a pet that is fully on screen where it is', () => {
  assert.deepEqual(clampPet({ x: 500, y: 400 }, opts), { x: 500, y: 400, grounded: false });
});

test('clampPet lets the transparent margin leave the screen but not the body', () => {
  // body left edge = x + 15 must stay >= 0, so x can go to -15
  assert.equal(clampPet({ x: -300, y: 400 }, opts).x, -15);
  // body right edge = x + 135 must stay <= 1920
  assert.equal(clampPet({ x: 5000, y: 400 }, opts).x, 1785);
  // body top = y + 16 must stay >= 0
  assert.equal(clampPet({ x: 500, y: -200 }, opts).y, -16);
});

test('clampPet never lets the body go behind the taskbar and snaps onto it', () => {
  // body bottom = y + 128 must stay <= 1032, so the ground is y = 904
  assert.deepEqual(clampPet({ x: 500, y: 2000 }, opts), { x: 500, y: 904, grounded: true });
  assert.deepEqual(clampPet({ x: 500, y: 885 }, opts), { x: 500, y: 904, grounded: true });
  assert.deepEqual(clampPet({ x: 500, y: 870 }, opts), { x: 500, y: 870, grounded: false });
});

test('clampPet respects a work area that does not start at 0,0 (second monitor / top taskbar)', () => {
  const second = { ...opts, workArea: { x: 1920, y: 40, width: 1280, height: 984 } };
  assert.deepEqual(clampPet({ x: 1800, y: 0 }, second), { x: 1905, y: 24, grounded: false });
});

test('chooseFacing turns the pet toward the middle of the screen, with a dead zone so it does not flip-flop', () => {
  const wa = { x: 0, y: 0, width: 2000, height: 1000 };
  assert.equal(chooseFacing({ centerX: 100, workArea: wa, current: -1 }), 1); // left side -> face right
  assert.equal(chooseFacing({ centerX: 1900, workArea: wa, current: 1 }), -1); // right side -> face left
  assert.equal(chooseFacing({ centerX: 1040, workArea: wa, current: 1 }), 1); // near the middle: keep facing
  assert.equal(chooseFacing({ centerX: 1040, workArea: wa, current: -1 }), -1);
  // second monitor offset
  assert.equal(chooseFacing({ centerX: 2100, workArea: { x: 2000, y: 0, width: 1000, height: 800 }, current: -1 }), 1);
});

test('mirrorInsets swaps left and right when the pet is flipped', () => {
  const insets = { top: 0.05, right: 0.12, bottom: 0.09, left: 0.15 };
  assert.deepEqual(mirrorInsets(insets, false), insets);
  assert.deepEqual(mirrorInsets(insets, true), { top: 0.05, right: 0.15, bottom: 0.09, left: 0.12 });
});

test('panelPlacement puts the panel above the pet, centered and inside the screen', () => {
  const panelSize = { width: 240, height: 200 };
  const placed = panelPlacement({ petPos: { x: 500, y: 904 }, petSize, insets, panelSize, workArea, gap: 4, margin: 8 });
  // body top = 920; panel bottom = 916 -> y = 716; centered on pet center x 575 -> x = 455
  assert.deepEqual(placed, { x: 455, y: 716, side: 'above' });
});

test('panelPlacement flips below when there is no room above, and stays inside the sides', () => {
  const panelSize = { width: 240, height: 200 };
  const placed = panelPlacement({ petPos: { x: -15, y: 10 }, petSize, insets, panelSize, workArea, gap: 4, margin: 8 });
  // body bottom = 10 + 128 = 138; below y = 142; x clamps to margin 8
  assert.deepEqual(placed, { x: 8, y: 142, side: 'below' });
});

test('positionChanged asks for a save only when the pet really moved', () => {
  assert.equal(positionChanged(null, { x: 10, y: 20 }), true);
  assert.equal(positionChanged({ x: 10, y: 20 }, { x: 10, y: 20 }), false);
  assert.equal(positionChanged({ x: 10, y: 20 }, { x: 11, y: 20 }), true);
  assert.equal(positionChanged({ x: 10, y: 20 }, null), false);
});
