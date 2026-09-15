// Runs the pet window script in a sandbox with a fake Rive runtime and host bridge.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SCRIPT = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'pet.js'), 'utf8');

function loadPetScript(petConfig) {
  const host = { failures: [], handlers: {} };
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
  const element = { addEventListener() {}, setPointerCapture() {}, classList: { add() {}, remove() {} } };
  const on = (name) => (callback) => { host.handlers[name] = callback; };
  const context = {
    console: { error() {}, log() {}, warn() {} },
    setTimeout,
    performance,
    requestAnimationFrame: () => { frames += 1; },
    document: { getElementById: () => element, addEventListener() {}, body: { classList: { toggle() {} } } },
    window: {
      addEventListener() {},
      petHost: {
        getConfig: async () => petConfig,
        loadFailed: (message) => host.failures.push(message),
        onView: on('view'),
        onStats: on('stats'),
        onReaction: on('reaction'),
        onHeld: on('held'),
        onLook: on('look'),
      },
    },
    rive: {
      RuntimeLoader: { setWasmUrl() {} },
      Layout: class {},
      Fit: {},
      Alignment: {},
      Rive: class {
        constructor(options) {
          riveOptions = options;
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
    get riveOptions() { return riveOptions; },
    get frames() { return frames; },
    pending: () => vm.runInContext('pendingReactions.length', context),
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));
const view = { petState: 'working', orbs: {}, orbColors: {}, facing: 1 };

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
