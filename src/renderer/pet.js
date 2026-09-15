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

let petConfig = null;
let riveInstance = null;
let riveReady = false;
let lastView = null;
let stats = { open: false, side: 'above' };
let hovered = false;
let held = { held: false, lean: 0 };
let lastHoverSent = 0;
const pendingReactions = [];
const look = { x: 0, y: 0, targetX: 0, targetY: 0 };

// ---------- Rive ----------

async function initPet() {
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
    onLoadError: (err) => console.error('[pet] could not load pet file', err),
  });
}

function viewModel() {
  return riveReady ? riveInstance.viewModelInstance : null;
}

function stateValue(name) {
  const states = petConfig.states;
  if (name in states) return states[name];
  const fallback = FALLBACK_STATES[name];
  if (fallback in states) return states[fallback];
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
  const vm = viewModel();
  if (!vm) {
    pendingReactions.push(name);
    return;
  }
  const trigger = vm.trigger(name);
  if (trigger) trigger.trigger();
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

// Eases the gaze toward the latest cursor direction so the eyes glide instead of jumping.
function smoothLook() {
  const vm = viewModel();
  if (vm) {
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

// ---------- hover, click, drag, menu ----------

canvas.addEventListener('pointerenter', () => {
  hovered = true;
  applyPet();
});

canvas.addEventListener('pointerleave', () => {
  hovered = false;
  applyPet();
});

let dragging = false;
let moved = false;
let downAt = null;

canvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  dragging = true;
  moved = false;
  downAt = { x: e.screenX, y: e.screenY };
  canvas.setPointerCapture(e.pointerId);
});

canvas.addEventListener('pointermove', (e) => {
  if (!dragging) {
    // rubbing the cursor back and forth pets the pet; main process recognizes the gesture
    if (e.timeStamp - lastHoverSent > 30) {
      lastHoverSent = e.timeStamp;
      window.petHost.hoverMove(e.screenX);
    }
    return;
  }
  if (!moved && Math.hypot(e.screenX - downAt.x, e.screenY - downAt.y) > 4) {
    moved = true;
    canvas.classList.add('dragging');
    window.petHost.dragStart();
  }
  if (moved) window.petHost.dragMove();
});

canvas.addEventListener('pointerup', () => {
  if (!dragging) return;
  dragging = false;
  canvas.classList.remove('dragging');
  if (moved) window.petHost.dragEnd();
  else window.petHost.click(); // main process counts clicks: 1 = stats, 2 = trick, 3+ = tickle
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.petHost.closeStats();
});

document.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  window.petHost.contextMenu();
});

initPet();
