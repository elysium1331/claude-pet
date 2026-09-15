// Runs the pet window script in a sandbox with a fake Rive runtime and host bridge.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const PetAmbient = require('../src/renderer/ambient');

const SCRIPT = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'pet.js'), 'utf8');

function loadPetScript(petConfig, options = {}) {
  const host = { failures: [], handlers: {}, sent: [] };
  const props = {};
  const triggers = [];
  const viewModel = {
    number: (name) => (props[name] ??= { value: undefined }),
    boolean: (name) => (props[name] ??= { value: undefined }),
    color: () => ({ rgb() {} }),
    trigger: (name) => ({ trigger: () => triggers.push(name) }),
  };
  let riveOptions = null;
  let frames = 0;
  const canvasListeners = {};
  const documentListeners = {};
  const element = {
    addEventListener: (type, fn) => { canvasListeners[type] = fn; },
    setPointerCapture() {},
    classList: { add() {}, remove() {}, toggle() {} },
  };
  const document = {
    hidden: false,
    getElementById: () => element,
    addEventListener: (type, fn) => { documentListeners[type] = fn; },
    body: { classList: { toggle() {} } },
  };
  const on = (name) => (callback) => { host.handlers[name] = callback; };
  const record = (name) => (...args) => { host.sent.push([name, ...args]); };
  const context = {
    console: { error() {}, log() {}, warn() {} },
    setTimeout: options.setTimeout ?? setTimeout,
    clearTimeout: options.clearTimeout ?? clearTimeout,
    performance: options.performance ?? performance,
    requestAnimationFrame: () => { frames += 1; },
    document,
    window: {
      addEventListener() {},
      PetAmbient: options.ambient ? PetAmbient : undefined,
      petHost: {
        getConfig: async () => petConfig,
        loadFailed: (message) => host.failures.push(message),
        onView: on('view'),
        onStats: on('stats'),
        onReaction: on('reaction'),
        onHeld: on('held'),
        onLook: on('look'),
        onHover: on('hover'),
        press: record('press'),
        release: record('release'),
        click: record('click'),
        dragStart: record('dragStart'),
        dragMove: record('dragMove'),
        dragEnd: record('dragEnd'),
        hoverMove: record('hoverMove'),
        closeStats: record('closeStats'),
        contextMenu: record('contextMenu'),
      },
    },
    rive: {
      RuntimeLoader: { setWasmUrl() {} },
      Layout: class {},
      Fit: {},
      Alignment: {},
      Rive: class {
        constructor(riveOptionsArg) {
          riveOptions = riveOptionsArg;
          this.viewModelInstance = viewModel;
        }

        resizeDrawingSurfaceToCanvas() {}
      },
    },
  };
  vm.createContext(context);
  vm.runInContext(SCRIPT, context);
  return {
    host,
    props,
    triggers,
    context,
    document,
    get riveOptions() { return riveOptions; },
    get frames() { return frames; },
    pending: () => vm.runInContext('pendingReactions.length', context),
    pointer: (type, event = {}) => canvasListeners[type](event),
    fire: (type) => documentListeners[type](),
    sentNames: () => host.sent.map(([name]) => name),
    frame: () => vm.runInContext('smoothLook()', context),
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));
const view = { petState: 'working', orbs: {}, orbColors: {}, facing: 1 };
const press = { button: 0, buttons: 1, pointerId: 1, screenX: 100, screenY: 100, timeStamp: 0 };

test('a Rive load failure is reported to the main process once and stops queueing reactions', async () => {
  const pet = loadPetScript({ states: { idle: 0 }, binding: {}, reactions: {} });
  await flush();
  for (let i = 0; i < 50; i += 1) pet.host.handlers.reaction('yawn');
  assert.equal(pet.pending(), 10); // capped while waiting for the file
  pet.riveOptions.onLoadError({ type: 'loaderror', data: 'WebGL2 is not available' });
  pet.riveOptions.onLoadError({ type: 'loaderror', data: 'again' });
  assert.deepEqual(pet.host.failures, ['WebGL2 is not available']);
  pet.host.handlers.reaction('yawn');
  assert.equal(pet.pending(), 0);
});

test('a pet config without states still finishes loading', async () => {
  const pet = loadPetScript({ binding: { stateProperty: 'state' }, reactions: { appear: 'appear' } });
  await flush();
  pet.host.handlers.view(view); // the first view arrives before the file has loaded
  assert.doesNotThrow(() => pet.riveOptions.onLoad());
  assert.equal(pet.props.state.value, 0);
  assert.deepEqual(pet.triggers, ['appear']);
  assert.equal(pet.frames, 1); // gaze and ambient motion loop started
  assert.deepEqual(pet.host.failures, []);
});

test('states inherited from Object.prototype are not treated as poses', async () => {
  const pet = loadPetScript({ binding: { stateProperty: 'state' }, states: { idle: 4, working: 2 } });
  await flush();
  pet.host.handlers.view({ ...view, petState: 'constructor' });
  pet.riveOptions.onLoad();
  assert.equal(pet.props.state.value, 4);
});

test('a drag the system cancels (e.g. a touch pan) still ends, and hovering afterwards does not move the pet', async () => {
  const pet = loadPetScript({ states: { idle: 0 }, binding: {}, reactions: {} });
  await flush();
  pet.pointer('pointerdown', press);
  pet.pointer('pointermove', { ...press, screenX: 120, timeStamp: 10 });
  pet.pointer('pointercancel');
  pet.pointer('pointermove', { ...press, buttons: 0, screenX: 130, timeStamp: 100 });
  assert.deepEqual(pet.sentNames(), ['press', 'dragStart', 'dragMove', 'dragEnd', 'hoverMove']);
});

test('a press whose release never arrives ends on the next move with no button down, and is not a click', async () => {
  const pet = loadPetScript({ states: { idle: 0 }, binding: {}, reactions: {} });
  await flush();
  pet.pointer('pointerdown', press);
  pet.pointer('pointermove', { ...press, buttons: 0, screenX: 101, timeStamp: 100 });
  assert.deepEqual(pet.sentNames(), ['press', 'release', 'hoverMove']);
});

test('losing pointer capture ends a press; a second pointer does not start another; a normal release is a click', async () => {
  const pet = loadPetScript({ states: { idle: 0 }, binding: {}, reactions: {} });
  await flush();
  pet.pointer('pointerdown', press);
  pet.pointer('pointerdown', { ...press, pointerId: 2 });
  pet.pointer('lostpointercapture');
  pet.pointer('pointerdown', press);
  pet.pointer('pointerup', press);
  pet.pointer('lostpointercapture'); // always follows a pointerup
  assert.deepEqual(pet.sentNames(), ['press', 'release', 'press', 'click']);
});

test('the hovered look follows the main process, which only counts the body', async () => {
  const pet = loadPetScript({ states: { idle: 0 }, binding: { hoveredProperty: 'hovered' }, reactions: {} });
  await flush();
  pet.host.handlers.view(view);
  pet.riveOptions.onLoad();
  pet.host.handlers.hover(true);
  assert.equal(pet.props.hovered.value, true);
  pet.host.handlers.hover(false);
  assert.equal(pet.props.hovered.value, false);
});

test('turning ear and tail twitches off eases them back to rest instead of freezing them', async (t) => {
  t.mock.method(Math, 'random', () => 0.3);
  let now = 0;
  const binding = { earLeftProperty: 'earLeft', earRightProperty: 'earRight', tailSwayProperty: 'tailSway' };
  const pet = loadPetScript({ states: { idle: 0 }, binding, reactions: {} }, { ambient: true, performance: { now: () => now } });
  await flush();
  const run = (ms) => {
    for (const end = now + ms; now < end;) {
      now += 16;
      pet.frame();
    }
  };
  pet.host.handlers.view({ ...view, petState: 'idle', ambientMotion: true });
  pet.riveOptions.onLoad();
  run(6000);
  assert.ok(Math.abs(pet.props.tailSway.value) > 0.05, `the tail has drifted (${pet.props.tailSway.value})`);
  pet.host.handlers.view({ ...view, petState: 'idle', ambientMotion: false });
  run(5000);
  const rest = [pet.props.earLeft.value, pet.props.earRight.value, pet.props.tailSway.value].map((v) => v + 0); // -0 is 0
  assert.deepEqual(rest, [0, 0, 0]);
  pet.props.tailSway.value = 0.5; // once at rest, nothing writes them any more
  run(200);
  assert.equal(pet.props.tailSway.value, 0.5);
});

test('after a wake-up hop the pose is put back, but not until a hidden pet is shown and has hopped', async () => {
  const timers = [];
  const runTimers = () => timers.splice(0).forEach((fn) => fn());
  const pet = loadPetScript(
    { states: { idle: 0, working: 2 }, binding: { stateProperty: 'state' }, reactions: { wake: 'perkUp' } },
    { setTimeout: (fn) => timers.push(fn), clearTimeout() {} },
  );
  await flush();
  pet.host.handlers.view(view);
  pet.riveOptions.onLoad();
  assert.equal(pet.props.state.value, 2);

  pet.document.hidden = true;
  pet.host.handlers.reaction('perkUp');
  pet.props.state.value = 0; // the hop resets the pose inside the pet file whenever it gets to play
  runTimers();
  assert.equal(pet.props.state.value, 0); // hidden: too early to put it back

  pet.document.hidden = false;
  pet.fire('visibilitychange');
  runTimers();
  assert.equal(pet.props.state.value, 2);

  pet.host.handlers.reaction('perkUp'); // visible: put back once the hop is done
  pet.props.state.value = 0;
  runTimers();
  assert.equal(pet.props.state.value, 2);
});
