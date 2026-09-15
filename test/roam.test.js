const test = require('node:test');
const assert = require('node:assert/strict');
const { shouldStartRoam, planRoam, stepToward, roamDelayMs, roamPose } = require('../src/main/roam');

test('roamPose floats at normal size by default, or walks if you prefer', () => {
  const prefs = { strollPose: 'float', taskbarPose: 'float' };
  assert.equal(roamPose('stroll', false, prefs), 'floatingTravel');
  assert.equal(roamPose('stroll', true, prefs), 'idle');
  assert.equal(roamPose('stroll', false, { ...prefs, strollPose: 'walk' }), 'walking');
  assert.equal(roamPose('stroll', true, { ...prefs, taskbarPose: 'sit' }), 'sitting');
  assert.equal(roamPose('wander', false, prefs), 'floatingTravel');
  assert.equal(roamPose('wander', true, { strollPose: 'walk', taskbarPose: 'sit' }), 'idle');
});

// deterministic "random" that replays a list of values
const sequence = (...values) => {
  let i = 0;
  return () => values[i++ % values.length];
};

const workArea = { x: 0, y: 0, width: 2000, height: 1000 };
const petSize = { width: 150, height: 160 };
const groundY = 850;
const clamp = (p) => ({
  x: Math.min(workArea.width - petSize.width, Math.max(0, p.x)),
  y: Math.min(groundY, Math.max(0, p.y)),
});

test('shouldStartRoam only when it is time, roaming is on, and the pet is idle and left alone', () => {
  const base = { mode: 'taskbar', now: 10_000, nextRoamAt: 5_000, state: 'sitting', busy: false, petIdleMs: 120_000 };
  assert.equal(shouldStartRoam(base), true);
  assert.equal(shouldStartRoam({ ...base, state: 'lounging' }), true); // gets up for a stroll
  assert.equal(shouldStartRoam({ ...base, state: 'idle' }), true);
  assert.equal(shouldStartRoam({ ...base, mode: 'off' }), false);
  assert.equal(shouldStartRoam({ ...base, now: 1_000 }), false);
  assert.equal(shouldStartRoam({ ...base, state: 'workingBusy' }), false);
  assert.equal(shouldStartRoam({ ...base, state: 'sleeping' }), false);
  assert.equal(shouldStartRoam({ ...base, busy: true }), false); // stats open, dragging, chasing, hidden
  assert.equal(shouldStartRoam({ ...base, petIdleMs: 20_000 }), false); // you just played with it
});

test('roamDelayMs waits between the configured minimum and maximum minutes', () => {
  assert.equal(roamDelayMs(10, 25, () => 0), 600_000);
  assert.equal(roamDelayMs(10, 25, () => 1), 1_500_000);
});

test('a taskbar stroll walks along the ground to a spot, pauses, then comes home', () => {
  const home = { x: 100, y: groundY };
  const plan = planRoam({ home, mode: 'taskbar', workArea, petSize, clamp, groundY, random: sequence(0.9) });
  assert.equal(plan.kind, 'stroll');
  const [out, back] = plan.waypoints;
  assert.equal(plan.waypoints.length, 2);
  assert.equal(out.y, groundY);
  assert.ok(Math.abs(out.x - home.x) >= 250, 'goes somewhere worth walking to');
  assert.ok(out.pauseMs >= 3000 && out.arrive);
  assert.deepEqual({ x: back.x, y: back.y }, home);
  assert.equal(back.home, true);
});

test('in screen mode it sometimes floats a curved path somewhere else on screen and back', () => {
  const home = { x: 100, y: groundY };
  // first value < 0.35 picks a wander; the rest place the target and curve
  const plan = planRoam({ home, mode: 'screen', workArea, petSize, clamp, groundY, random: sequence(0.1, 0.7, 0.3, 0.8) });
  assert.equal(plan.kind, 'wander');
  const arrival = plan.waypoints.find((w) => w.arrive);
  assert.ok(arrival.y < groundY, 'leaves the taskbar');
  assert.ok(plan.waypoints.length > 4, 'follows a curve, not a straight line');
  for (const w of plan.waypoints) assert.deepEqual(clamp(w), { x: w.x, y: w.y }, 'every point stays on screen');
  const last = plan.waypoints.at(-1);
  assert.deepEqual({ x: last.x, y: last.y }, home);
});

test('a wander is kept on screen with its own bounds, not those of the stroll pose', () => {
  // A very wide screen, so long trips bow their curves well above the top edge before clamping.
  const wide = { x: 0, y: 0, width: 5000, height: 1000 };
  const home = { x: 4800, y: groundY };
  // The walking pose has a big top margin, so a stroll's points may go well above the screen; floating ones may not.
  const walkClamp = (p) => ({ x: Math.min(4850, Math.max(0, p.x)), y: Math.min(groundY, Math.max(-75, p.y)) });
  const floatClamp = (p) => ({ x: Math.min(4850, Math.max(0, p.x)), y: Math.min(groundY, Math.max(-1, p.y)) });
  let wanders = 0;
  for (let seed = 0; seed < 200; seed += 1) {
    let n = seed;
    const random = () => {
      n = (n * 9301 + 49297) % 233280;
      return n / 233280;
    };
    const plan = planRoam({ home, mode: 'screen', workArea: wide, petSize, clamp: walkClamp, wanderClamp: floatClamp, groundY, random });
    if (plan.kind === 'wander') wanders += 1;
    const check = plan.kind === 'wander' ? floatClamp : walkClamp;
    for (const w of plan.waypoints) assert.deepEqual(check(w), { x: w.x, y: w.y }, `${plan.kind} point stays in its bounds`);
  }
  assert.ok(wanders > 20);
});

test('planRoam avoids ending up right where the cursor is', () => {
  const home = { x: 100, y: groundY };
  // first candidate lands under the cursor, the second one is clear
  const cursor = { x: 0.5 * 1850 + 75, y: groundY + 80 };
  const plan = planRoam({ home, mode: 'taskbar', workArea, petSize, clamp, groundY, cursor, random: sequence(0.5, 0.95) });
  const out = plan.waypoints[0];
  assert.ok(Math.hypot(out.x + 75 - cursor.x, out.y + 80 - cursor.y) > 200);
});

test('stepToward moves at most one step and reports arrival', () => {
  assert.deepEqual(stepToward({ x: 0, y: 0 }, { x: 30, y: 40 }, 10), { x: 6, y: 8, arrived: false });
  assert.deepEqual(stepToward({ x: 25, y: 38 }, { x: 30, y: 40 }, 10), { x: 30, y: 40, arrived: true });
});
