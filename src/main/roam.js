// Free roam: the pet occasionally takes a little trip and comes back. Pure (random and clamping injected) for tests.

const ROAM_STATES = new Set(['idle', 'sitting', 'lounging']);
const MIN_TRAVEL_PX = 250;
const CURSOR_CLEARANCE_PX = 200;
const WANDER_CHANCE = 0.35; // in "screen" mode, how often a trip leaves the taskbar
const CURVE_SAMPLES = [0.2, 0.4, 0.6, 0.8];

function shouldStartRoam({ mode, now, nextRoamAt, state, busy, petIdleMs, minIdleMs = 60_000 }) {
  return mode !== 'off' && now >= nextRoamAt && ROAM_STATES.has(state) && !busy && petIdleMs >= minIdleMs;
}

function roamDelayMs(minMinutes, maxMinutes, random = Math.random) {
  return Math.round((minMinutes + random() * (maxMinutes - minMinutes)) * 60_000);
}

// Points along a gentle curve from a to b (excluding both ends), bowed to one side.
function curve(a, b, clamp, random) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const bow = (random() < 0.5 ? -1 : 1) * 0.25;
  const control = { x: (a.x + b.x) / 2 - dy * bow, y: (a.y + b.y) / 2 + dx * bow };
  return CURVE_SAMPLES.map((t) => {
    const u = 1 - t;
    const point = clamp({
      x: Math.round(u * u * a.x + 2 * u * t * control.x + t * t * b.x),
      y: Math.round(u * u * a.y + 2 * u * t * control.y + t * t * b.y),
    });
    return { x: point.x, y: point.y, pauseMs: 0 };
  });
}

// Plans a trip: out to a spot (with a pause) and back home. Positions are pet-window top-left corners.
// clamp keeps a stroll's points on screen, wanderClamp a wander's: the two show different poses, with different bounds.
function planRoam({
  home, mode, workArea, petSize, clamp: strollClamp, wanderClamp = strollClamp, groundY, cursor = null, random = Math.random,
}) {
  const wander = mode === 'screen' && random() < WANDER_CHANCE;
  const clamp = wander ? wanderClamp : strollClamp;
  const minTravel = Math.min(MIN_TRAVEL_PX, workArea.width / 4);

  let target = null;
  for (let tries = 0; tries < 8; tries += 1) {
    const x = workArea.x + random() * (workArea.width - petSize.width);
    const y = wander ? workArea.y + random() * workArea.height * 0.6 : groundY;
    const candidate = clamp({ x: Math.round(x), y: Math.round(y) });
    const farEnough = Math.hypot(candidate.x - home.x, candidate.y - home.y) >= minTravel;
    const clearOfCursor = !cursor
      || Math.hypot(candidate.x + petSize.width / 2 - cursor.x, candidate.y + petSize.height / 2 - cursor.y) > CURSOR_CLEARANCE_PX;
    target = candidate;
    if (farEnough && clearOfCursor) break;
  }

  const arrival = { x: target.x, y: target.y, pauseMs: Math.round(3000 + random() * 3000), arrive: true };
  const waypoints = wander
    ? [...curve(home, target, clamp, random), arrival, ...curve(target, home, clamp, random)]
    : [arrival];
  waypoints.push({ x: home.x, y: home.y, pauseMs: 0, home: true });
  return { kind: wander ? 'wander' : 'stroll', waypoints };
}

function stepToward(pos, target, maxStep) {
  const dx = target.x - pos.x;
  const dy = target.y - pos.y;
  const distance = Math.hypot(dx, dy);
  if (distance <= maxStep) return { x: target.x, y: target.y, arrived: true };
  return {
    x: Math.round(pos.x + (dx / distance) * maxStep),
    y: Math.round(pos.y + (dy / distance) * maxStep),
    arrived: false,
  };
}

// Which pose to show during a trip. Floating keeps the pet at its normal size; walking is the compact ground gait.
function roamPose(kind, pausing, { strollPose = 'float', taskbarPose = 'float' } = {}) {
  if (kind === 'stroll') {
    if (pausing) return taskbarPose === 'sit' ? 'sitting' : 'idle';
    return strollPose === 'walk' ? 'walking' : 'floatingTravel';
  }
  return pausing ? 'idle' : 'floatingTravel';
}

module.exports = {
  ROAM_STATES, shouldStartRoam, roamDelayMs, planRoam, stepToward, roamPose,
};
