// Pure helpers for pet behavior (poses, reactions, gaze). No Electron imports so it can be unit tested.

const RESTING_STATES = new Set(['sleeping', 'lounging']);

// Some poses (like lying down) occupy a different part of the pet box than the floating pose.
function insetsForState(pet, state) {
  return pet.stateInsets?.[state] || pet.bodyInsets;
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

module.exports = { insetsForState, wakeReaction, fidgetsFor, lookFromCursor };
