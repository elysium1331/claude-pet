const test = require('node:test');
const assert = require('node:assert/strict');
const {
  clampPet, displayLimits, groundBelow, nearestDisplay, taskbarEdge, combinedInsets, bodyRect, panelPlacement, chooseFacing,
  mirrorInsets, scaledPetSize, resizeAnchored, positionChanged,
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

const screenOf = (workArea, bounds) => ({ workArea, bounds });

test('taskbarEdge finds the taskbar from the room it takes out of the work area', () => {
  const bounds = { x: 0, y: 0, width: 1920, height: 1080 };
  assert.equal(taskbarEdge(screenOf({ x: 0, y: 0, width: 1920, height: 1032 }, bounds)), 'bottom');
  assert.equal(taskbarEdge(screenOf({ x: 0, y: 48, width: 1920, height: 1032 }, bounds)), 'top');
  assert.equal(taskbarEdge(screenOf({ x: 62, y: 0, width: 1858, height: 1080 }, bounds)), 'left');
  assert.equal(taskbarEdge(screenOf({ x: 0, y: 0, width: 1858, height: 1080 }, bounds)), 'right');
  assert.equal(taskbarEdge(screenOf(bounds, bounds)), null); // auto-hide, or no taskbar on this display
  const second = { x: -1920, y: -200, width: 1920, height: 1080 };
  assert.equal(taskbarEdge(screenOf({ ...second, height: 1040 }, second)), 'bottom');
});

test('clampPet keeps the ground at the bottom of the work area when the taskbar is there', () => {
  const bounds = { x: 0, y: 0, width: 1920, height: 1080 };
  assert.deepEqual(clampPet({ x: 500, y: 2000 }, { ...opts, bounds }), { x: 500, y: 904, grounded: true });
});

test('with the taskbar hidden or elsewhere, the pet rests just above the bottom of the screen, never on its edge', () => {
  // top taskbar: body bottom = y + 128 stays 4px above the screen bottom (1080)
  const top = { ...opts, workArea: { x: 0, y: 48, width: 1920, height: 1032 }, bounds: { x: 0, y: 0, width: 1920, height: 1080 } };
  assert.deepEqual(clampPet({ x: 500, y: 2000 }, top), { x: 500, y: 948, grounded: true });
  assert.equal(clampPet({ x: 500, y: -500 }, top).y, 48 - 16, 'the body stops at the top taskbar, not under it');
  // auto-hide: the body keeps 4px away from every edge an auto-hidden taskbar could slide out of
  const hidden = { ...opts, workArea: { x: 0, y: 0, width: 1920, height: 1080 }, bounds: { x: 0, y: 0, width: 1920, height: 1080 } };
  assert.deepEqual(clampPet({ x: -500, y: 2000 }, hidden), { x: -15 + 4, y: 948, grounded: true });
  assert.equal(clampPet({ x: 5000, y: 400 }, hidden).x, 1785 - 4);
  assert.equal(clampPet({ x: 500, y: -500 }, hidden).y, -16 + 4);
  // left taskbar: the body stops at it, and the ground is the bottom of the screen
  const left = { ...opts, workArea: { x: 62, y: 0, width: 1858, height: 1080 }, bounds: { x: 0, y: 0, width: 1920, height: 1080 } };
  assert.deepEqual(clampPet({ x: -500, y: 2000 }, left), { x: 62 - 15, y: 948, grounded: true });
});

// Two 1920x1080 monitors with a taskbar each: the main one, and another to its left.
const mainScreen = screenOf({ x: 0, y: 0, width: 1920, height: 1032 }, { x: 0, y: 0, width: 1920, height: 1080 });
const leftScreen = screenOf({ x: -1920, y: 0, width: 1920, height: 1032 }, { x: -1920, y: 0, width: 1920, height: 1080 });
// A monitor above the main one, without a taskbar.
const upperScreen = screenOf({ x: 0, y: -1080, width: 1920, height: 1080 }, { x: 0, y: -1080, width: 1920, height: 1080 });
const onScreen = (display, displays) => ({ ...opts, ...displayLimits(display, displays) });

test('the pet can straddle two monitors that meet, and cross the seam without stopping or landing', () => {
  const displays = [mainScreen, leftScreen, upperScreen];
  // across a side seam: no wall at x = 0
  assert.deepEqual(clampPet({ x: -60, y: 400 }, onScreen(mainScreen, displays)), { x: -60, y: 400, grounded: false });
  assert.deepEqual(clampPet({ x: -60, y: 904 }, onScreen(mainScreen, displays)), { x: -60, y: 904, grounded: true });
  // up across the top seam: no wall at y = 0, and the upper monitor's bottom edge is not ground
  assert.deepEqual(clampPet({ x: 500, y: -60 }, onScreen(mainScreen, displays)), { x: 500, y: -60, grounded: false });
  assert.deepEqual(clampPet({ x: 500, y: -140 }, onScreen(upperScreen, displays)), { x: 500, y: -140, grounded: false });
  assert.deepEqual(clampPet({ x: 500, y: -1300 }, onScreen(upperScreen, displays)), { x: 500, y: -1080 - 16 + 4, grounded: false });
  // the outer edges are still walls
  assert.equal(clampPet({ x: 5000, y: 400 }, onScreen(mainScreen, displays)).x, 1785 - 4);
  assert.equal(clampPet({ x: -5000, y: 400 }, onScreen(leftScreen, displays)).x, -1920 - 15 + 4);
});

test('a seam is only crossed where the other monitor has room for the whole body', () => {
  // A shorter monitor to the right, lower down: its work area starts at y = 600.
  const shortScreen = screenOf({ x: 1920, y: 600, width: 1280, height: 400 }, { x: 1920, y: 600, width: 1280, height: 440 });
  const displays = [mainScreen, shortScreen];
  assert.equal(clampPet({ x: 1860, y: 100 }, onScreen(mainScreen, displays)).x, 1785 - 4, 'nothing to the right up here');
  assert.equal(clampPet({ x: 1860, y: 700 }, onScreen(mainScreen, displays)).x, 1860, 'but there is lower down');
  // A monitor whose own taskbar sits between them: the taskbar is a wall.
  const docked = screenOf({ x: 1982, y: 0, width: 1858, height: 1080 }, { x: 1920, y: 0, width: 1920, height: 1080 });
  assert.equal(clampPet({ x: 1860, y: 400 }, onScreen(mainScreen, [mainScreen, docked])).x, 1785 - 4);
});

test('groundBelow finds the ground straight down, carrying on into a monitor below', () => {
  const displays = [mainScreen, leftScreen, upperScreen];
  const ground = (x, display) => groundBelow(x, { petSize, insets, display, displays });
  assert.deepEqual(ground(500, mainScreen), { x: 500, y: 904, grounded: true });
  assert.deepEqual(ground(500, upperScreen), { x: 500, y: 904, grounded: true }, 'down onto the taskbar below');
  assert.deepEqual(ground(-800, leftScreen), { x: -800, y: 904, grounded: true });
  // an upper monitor that sticks out past the one below: its own bottom is the ground out there
  const wide = screenOf({ x: -400, y: -1080, width: 2720, height: 1080 }, { x: -400, y: -1080, width: 2720, height: 1080 });
  assert.deepEqual(groundBelow(-300, { petSize, insets, display: wide, displays: [mainScreen, wide] }), { x: -300, y: -160 - 4 + 32, grounded: true });
});

test('nearestDisplay picks the display a point is on, or the closest one', () => {
  const displays = [mainScreen, leftScreen, upperScreen];
  assert.equal(nearestDisplay({ x: 10, y: 10 }, displays), mainScreen);
  assert.equal(nearestDisplay({ x: 0, y: 500 }, displays), mainScreen);
  assert.equal(nearestDisplay({ x: -1, y: 500 }, displays), leftScreen);
  assert.equal(nearestDisplay({ x: 500, y: -1 }, displays), upperScreen);
  assert.equal(nearestDisplay({ x: 2000, y: 1300 }, displays), mainScreen);
  assert.equal(nearestDisplay({ x: -100, y: 1300 }, displays), leftScreen);
  assert.equal(nearestDisplay({ x: 5000, y: 5000 }, [mainScreen]), mainScreen);
});

test('combinedInsets keeps the smallest margin on each side', () => {
  assert.deepEqual(
    combinedInsets([{ top: 0.47, right: 0.086, bottom: 0.012, left: 0.086 }, { top: 0.007, right: 0.121, bottom: 0.065, left: 0.121 }, undefined]),
    { top: 0, right: 0, bottom: 0, left: 0 },
  );
  assert.deepEqual(
    combinedInsets([{ top: 0.47, right: 0.086, bottom: 0.012, left: 0.086 }, { top: 0.007, right: 0.121, bottom: 0.065, left: 0.121 }]),
    { top: 0.007, right: 0.086, bottom: 0.012, left: 0.086 },
  );
});

test('bodyRect is the pet box without its transparent margins', () => {
  // left 15, top 16, right 15, bottom 32 px of margin
  assert.deepEqual(bodyRect({ x: 500, y: 904 }, petSize, insets), { left: 515, top: 920, right: 635, bottom: 1032 });
  assert.deepEqual(
    bodyRect({ x: -10, y: 0 }, petSize, { top: 0, right: 0, bottom: 0, left: 0 }),
    { left: -10, top: 0, right: 140, bottom: 160 },
  );
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

test('panelPlacement keeps a panel that fits on neither side off as much of the pet as it can', () => {
  // Above needs the body top at 220 or lower down, below needs its bottom at 180 or higher up: neither fits.
  const short = { x: 0, y: 0, width: 1097, height: 400 };
  const panelSize = { width: 240, height: 208 };
  const overlap = (placed, petY) => {
    const body = bodyRect({ x: 500, y: petY }, petSize, insets);
    return Math.min(body.bottom, placed.y + panelSize.height) - Math.max(body.top, placed.y);
  };
  // body 100..212: room above 100 - 4 - 8 = 88, below 392 - 216 = 176, so below, pinned to the bottom
  const low = panelPlacement({ petPos: { x: 500, y: 84 }, petSize, insets, panelSize, workArea: short, gap: 4, margin: 8 });
  assert.deepEqual(low, { x: 455, y: 184, side: 'below' });
  assert.equal(overlap(low, 84), 28); // pinned to the top it would cover the whole body (112px)
  // body 200..312: more room above, so it pins to the top instead
  const high = panelPlacement({ petPos: { x: 500, y: 184 }, petSize, insets, panelSize, workArea: short, gap: 4, margin: 8 });
  assert.deepEqual(high, { x: 455, y: 8, side: 'above' });
  assert.equal(overlap(high, 184), 16);
  // taller than the whole work area: it starts at the top
  const tall = panelPlacement({ petPos: { x: 500, y: 200 }, petSize, insets, panelSize: { width: 240, height: 600 }, workArea: short, gap: 4, margin: 8 });
  assert.equal(tall.y, 8);
});

test('positionChanged asks for a save only when the pet really moved', () => {
  assert.equal(positionChanged(null, { x: 10, y: 20 }), true);
  assert.equal(positionChanged({ x: 10, y: 20 }, { x: 10, y: 20 }), false);
  assert.equal(positionChanged({ x: 10, y: 20 }, { x: 11, y: 20 }), true);
  assert.equal(positionChanged({ x: 10, y: 20 }, null), false);
});
