/* global rive */
const canvas = document.getElementById('pet');

// If a pet file doesn't have a state yet, show the closest one it does have.
const FALLBACK_STATES = {
  lounging: 'sleeping',
  disconnected: 'needsAttention',
  workingBusy: 'working',
  walking: 'chasing',
  floatingTravel: 'chasing',
};
const LOOK_SMOOTHING = 0.18;
const MAX_PENDING_REACTIONS = 10;
const WAKE_HOP_MS = 1600; // how long the wake-up hop plays

let petConfig = null;
let riveInstance = null;
let riveReady = false;
let riveFailed = false;
let lastView = null;
let stats = { open: false, side: 'above' };
let hovered = false;
let held = { held: false, lean: 0 };
let wakeRestorePending = false;
let wakeTimer = null;
const pendingReactions = [];
const look = { x: 0, y: 0, targetX: 0, targetY: 0 };

// ---------- Rive ----------

async function initPet() {
  try {
    petConfig = await window.petHost.getConfig();
    rive.RuntimeLoader.setWasmUrl(petConfig.wasmUrl);
    riveInstance = new rive.Rive({
      src: petConfig.petUrl,
      canvas,
      artboard: petConfig.artboard,
      stateMachines: petConfig.stateMachine,
      autoplay: true,
      autoBind: true,
      layout: new rive.Layout({ fit: rive.Fit.Contain, alignment: rive.Alignment.Center }),
      onLoad: () => {
        riveInstance.resizeDrawingSurfaceToCanvas();
        riveReady = true;
        applyPet();
        if (petConfig.reactions?.appear) playReaction(petConfig.reactions.appear);
        pendingReactions.splice(0).forEach(playReaction);
        requestAnimationFrame(smoothLook);
      },
      onLoadError: (event) => reportLoadFailure(event?.data ?? event),
    });
  } catch (err) {
    reportLoadFailure(err);
  }
}

// Without WebGL2, a working wasm or a matching .riv nothing is drawn; tell the main process so it can react.
function reportLoadFailure(err) {
  if (riveFailed) return;
  riveFailed = true;
  pendingReactions.length = 0;
  console.error('[pet] could not load pet file', err);
  window.petHost.loadFailed(String(err?.message ?? err ?? 'unknown error'));
}

function viewModel() {
  return riveReady ? riveInstance.viewModelInstance : null;
}

function stateValue(name) {
  const states = petConfig.states || {};
  if (Object.hasOwn(states, name)) return states[name];
  const fallback = FALLBACK_STATES[name];
  if (fallback && Object.hasOwn(states, fallback)) return states[fallback];
  return states.idle ?? 0;
}

function setNumber(vm, name, value) {
  const prop = name && vm.number(name);
  if (prop && prop.value !== value) prop.value = value;
}

function setBoolean(vm, name, value) {
  const prop = name && vm.boolean(name);
  if (prop && prop.value !== value) prop.value = value;
}

const lastColors = {};

function setColor(vm, name, hex) {
  if (!name || !hex || lastColors[name] === hex) return;
  const prop = vm.color(name);
  if (!prop) return;
  const n = parseInt(hex.slice(1), 16);
  prop.rgb((n >> 16) & 255, (n >> 8) & 255, n & 255);
  lastColors[name] = hex;
}

function playReaction(name) {
  if (riveFailed) return;
  const vm = viewModel();
  if (!vm) {
    pendingReactions.push(name);
    if (pendingReactions.length > MAX_PENDING_REACTIONS) pendingReactions.shift();
    return;
  }
  const trigger = vm.trigger(name);
  if (trigger) trigger.trigger();
  if (name === petConfig.reactions?.wake) {
    wakeRestorePending = true;
    scheduleWakeRestore();
  }
}

// The wake-up hop resets the pose to idle inside the pet file; put back the pose the app wants once it's done.
function scheduleWakeRestore() {
  clearTimeout(wakeTimer);
  wakeTimer = setTimeout(restorePoseAfterWake, WAKE_HOP_MS);
}

function restorePoseAfterWake() {
  // A hidden window doesn't animate, so the hop hasn't played yet: wait until the pet is shown (visibilitychange).
  if (!wakeRestorePending || document.hidden) return;
  wakeRestorePending = false;
  applyPet();
}

function applyPet() {
  const vm = viewModel();
  if (!vm || !lastView) return;
  const binding = petConfig.binding || {};
  setNumber(vm, binding.stateProperty, stateValue(lastView.petState));
  const orbs = binding.usageProperties || {};
  setNumber(vm, orbs.session, lastView.orbs.session);
  setNumber(vm, orbs.weekly, lastView.orbs.weekly);
  setNumber(vm, orbs.model, lastView.orbs.model);
  const colors = binding.usageColorProperties || {};
  setColor(vm, colors.session, lastView.orbColors.session);
  setColor(vm, colors.weekly, lastView.orbColors.weekly);
  setColor(vm, colors.model, lastView.orbColors.model);
  setBoolean(vm, binding.lightBackdropProperty, lastView.lightBackdrop);
  setBoolean(vm, binding.hoveredProperty, hovered);
  setNumber(vm, binding.facingProperty, lastView.facing < 0 ? -1 : 1);
  setNumber(vm, binding.happinessProperty, lastView.happiness ?? 50);
  setNumber(vm, binding.growthProperty, lastView.growth ?? 0);
  setNumber(vm, binding.paletteProperty, lastView.palette ?? 0);
  setBoolean(vm, binding.nightModeProperty, !!lastView.nightMode);
  setBoolean(vm, binding.heldProperty, held.held);
  setNumber(vm, binding.dragLeanProperty, held.lean);
  setNumber(vm, binding.statsSideProperty, stats.side === 'below' ? 1 : 0); // side must be set before open
  setBoolean(vm, binding.statsOpenProperty, stats.open);
}

const ambient = window.PetAmbient ? window.PetAmbient.createAmbient() : null;
const CALM_STATES = new Set(['sleeping']);
const TRAVEL_STATES = new Set(['floatingTravel', 'walking', 'chasing']); // tail held up behind while on the move
const TRAVEL_TAIL_LIFT = 0.6;
const numberSupport = {};
const AT_REST = 0.005;
let ambientAtRest = true; // ears and tail are back at 0, so nothing needs writing while ambient motion is off

// Checks once whether the pet file has a Number property, so missing ones aren't looked up every frame.
function hasNumber(vm, name) {
  if (!name) return false;
  if (!(name in numberSupport)) numberSupport[name] = !!vm.number(name);
  return numberSupport[name];
}

function stepAmbient(vm) {
  const binding = petConfig.binding || {};
  const names = [binding.earLeftProperty, binding.earRightProperty, binding.tailSwayProperty];
  if (!ambient || !names.some((n) => hasNumber(vm, n))) return;
  const enabled = !!lastView?.ambientMotion;
  if (!enabled && ambientAtRest) return;
  // Switched off: keep easing ears and tail back to rest, since the pet file holds whatever value it was given last.
  ambient.setCalm(!enabled || CALM_STATES.has(lastView.petState) || held.held);
  ambient.setTailLift(enabled && TRAVEL_STATES.has(lastView.petState) ? TRAVEL_TAIL_LIFT : 0);
  const motion = ambient.step(performance.now());
  const values = [motion.earLeft, motion.earRight, motion.tailSway];
  ambientAtRest = !enabled && values.every((v) => Math.abs(v) < AT_REST);
  names.forEach((name, i) => {
    if (hasNumber(vm, name)) setNumber(vm, name, ambientAtRest ? 0 : Math.round(values[i] * 1000) / 1000);
  });
}

window.addEventListener('resize', () => {
  if (riveReady) riveInstance.resizeDrawingSurfaceToCanvas(); // pet size changed
});

// Eases the gaze toward the latest cursor direction so the eyes glide instead of jumping; also drives ambient motion.
function smoothLook() {
  const vm = viewModel();
  if (vm) {
    stepAmbient(vm);
    const binding = petConfig.binding || {};
    const nextX = look.x + (look.targetX - look.x) * LOOK_SMOOTHING;
    const nextY = look.y + (look.targetY - look.y) * LOOK_SMOOTHING;
    if (Math.abs(nextX - look.x) > 0.001 || Math.abs(nextY - look.y) > 0.001) {
      look.x = nextX;
      look.y = nextY;
      setNumber(vm, binding.lookXProperty, Math.round(look.x * 1000) / 1000);
      setNumber(vm, binding.lookYProperty, Math.round(look.y * 1000) / 1000);
    }
  }
  requestAnimationFrame(smoothLook);
}

window.petHost.onView((view) => {
  lastView = view;
  document.body.classList.toggle('flipped', !!view.flipped); // turn to face the middle of the screen
  applyPet();
});

window.petHost.onStats((next) => {
  stats = { ...stats, ...next };
  applyPet();
});

window.petHost.onReaction(playReaction);

window.petHost.onHeld((next) => {
  held = next;
  applyPet();
});

window.petHost.onLook(({ x, y }) => {
  look.targetX = x;
  look.targetY = y;
});

// Decided by the main process: only the body counts, not the see-through margins of the window around it.
// (The pointer itself is shaped by the hit-area window over the body.)
window.petHost.onHover((over) => {
  hovered = !!over;
  canvas.classList.toggle('hovered', hovered);
  applyPet();
});

// Clicks, drags, touches and right-clicks never reach this window: the hit-area window over the body takes them.

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && wakeRestorePending) scheduleWakeRestore();
});

initPet();
