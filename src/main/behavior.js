// Pure helpers for pet behavior (poses, reactions, gaze). No Electron imports so it can be unit tested.

const RESTING_STATES = new Set(['sleeping', 'lounging']);

// Some poses (like lying down) occupy a different part of the pet box than the floating pose.
function insetsForState(pet, state, facing = 1) {
  const insets = pet.stateInsets?.[state] || pet.bodyInsets;
  // pets that really turn (instead of being mirrored) can give separate bounds per direction
  if (insets && typeof insets.right === 'object') return facing < 0 ? insets.left : insets.right;
  return insets;
}

// Reaction to play when the pet gets up from a resting pose, or null.
function wakeReaction(pet, previousState, nextState) {
  const wake = pet.reactions?.wake;
  if (!wake) return null;
  return RESTING_STATES.has(previousState) && !RESTING_STATES.has(nextState) ? wake : null;
}

// Idle fidgets that make sense in the current pose. A fidget without `states` is idle-only.
function fidgetsFor(pet, state) {
  return (pet.fidgets || []).filter((f) => (f.states || ['idle']).includes(state));
}

function clampUnit(value) {
  return Math.round(Math.min(1, Math.max(-1, value)) * 100) / 100;
}

// Gaze direction (-1..1 on each axis) toward the cursor; `reach` is the distance for a full glance.
function lookFromCursor({ cursor, center, flipped = false, reach = 450 }) {
  const x = clampUnit((cursor.x - center.x) / reach) * (flipped ? -1 : 1);
  return { x: x === 0 ? 0 : x, y: clampUnit((cursor.y - center.y) / reach) };
}

const RESET_DROP_POINTS = 20; // a drop this large between checks means a limit reset, not rounding noise

function meterPairs(prev, next) {
  const pairs = [[prev.session, next.session], [prev.weekly, next.weekly]];
  for (const meter of next.scoped || []) {
    pairs.push([(prev.scoped || []).find((m) => m.label === meter.label), meter]);
  }
  return pairs.filter(([a, b]) => a && b);
}

// Usage events worth a reaction between two successful usage checks: ['usageReset'], ['limitHit'] or [].
function usageEvents(prev, next) {
  if (!prev || !next) return [];
  const pairs = meterPairs(prev, next);
  if (pairs.some(([a, b]) => a.percent - b.percent >= RESET_DROP_POINTS)) return ['usageReset'];
  if (pairs.some(([a, b]) => a.percent < 100 && b.percent >= 100)) return ['limitHit'];
  return [];
}

function localDateKey(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function shouldGreet(lastGreetDate, now = new Date()) {
  return lastGreetDate !== localDateKey(now);
}

// Closest pose to use when a pet file doesn't have the requested one (yet).
const STATE_FALLBACKS = {
  lounging: 'sleeping',
  disconnected: 'needsAttention',
  workingBusy: 'working',
  walking: 'chasing',
  floatingTravel: 'chasing',
};

function resolveState(pet, state) {
  const states = pet.states || {};
  if (state in states) return state;
  const fallback = STATE_FALLBACKS[state];
  if (fallback in states) return fallback;
  return 'idle' in states ? 'idle' : state;
}

// Whether `now` falls in the night window [startHour, endHour), which may wrap past midnight.
function isNightTime(now, startHour, endHour) {
  const hour = now.getHours() + now.getMinutes() / 60;
  return startHour <= endHour
    ? hour >= startHour && hour < endHour
    : hour >= startHour || hour < endHour;
}

// On the taskbar with nothing going on, a pet that can sit sits instead of floating (unless you prefer it floating).
function restingPose(pet, state, grounded, taskbarPose = 'sit') {
  const sits = taskbarPose === 'sit' && 'sitting' in (pet.states || {});
  return state === 'idle' && grounded && sits ? 'sitting' : state;
}

module.exports = {
  resolveState,
  isNightTime,
  restingPose,
  insetsForState,
  wakeReaction,
  fidgetsFor,
  lookFromCursor,
  usageEvents,
  localDateKey,
  shouldGreet,
};
