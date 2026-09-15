// Runs the hit-area window script (clicks, drags, touches and right-clicks on the pet's body) with a fake host bridge.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SCRIPT = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'hit-area.js'), 'utf8');

function loadHitArea() {
  const sent = [];
  const areaListeners = {};
  const documentListeners = {};
  const classes = new Set();
  const area = {
    addEventListener: (type, fn) => { areaListeners[type] = fn; },
    setPointerCapture() {},
    classList: { add: (name) => classes.add(name), remove: (name) => classes.delete(name) },
  };
  const record = (name) => (...args) => { sent.push([name, ...args]); };
  const names = ['press', 'release', 'click', 'dragStart', 'dragMove', 'dragEnd', 'hoverMove', 'closeStats', 'contextMenu'];
  const context = {
    document: {
      getElementById: () => area,
      addEventListener: (type, fn) => { documentListeners[type] = fn; },
    },
    window: { petHost: Object.fromEntries(names.map((name) => [name, record(name)])) },
  };
  vm.createContext(context);
  vm.runInContext(SCRIPT, context);
  return {
    classes,
    pointer: (type, event = {}) => areaListeners[type](event),
    fire: (type, event = {}) => documentListeners[type](event),
    sentNames: () => sent.map(([name]) => name),
  };
}

const press = { button: 0, buttons: 1, pointerId: 1, screenX: 100, screenY: 100, timeStamp: 0 };

test('a drag the system cancels (e.g. a touch pan) still ends, and hovering afterwards does not move the pet', () => {
  const area = loadHitArea();
  area.pointer('pointerdown', press);
  area.pointer('pointermove', { ...press, screenX: 120, timeStamp: 10 });
  assert.equal(area.classes.has('dragging'), true);
  area.pointer('pointercancel');
  area.pointer('pointermove', { ...press, buttons: 0, screenX: 130, timeStamp: 100 });
  assert.deepEqual(area.sentNames(), ['press', 'dragStart', 'dragMove', 'dragEnd', 'hoverMove']);
  assert.equal(area.classes.has('dragging'), false);
});

test('a press whose release never arrives ends on the next move with no button down, and is not a click', () => {
  const area = loadHitArea();
  area.pointer('pointerdown', press);
  area.pointer('pointermove', { ...press, buttons: 0, screenX: 101, timeStamp: 100 });
  assert.deepEqual(area.sentNames(), ['press', 'release', 'hoverMove']);
});

test('losing pointer capture ends a press; a second pointer does not start another; a normal release is a click', () => {
  const area = loadHitArea();
  area.pointer('pointerdown', press);
  area.pointer('pointerdown', { ...press, pointerId: 2 });
  area.pointer('lostpointercapture');
  area.pointer('pointerdown', press);
  area.pointer('pointerup', press);
  area.pointer('lostpointercapture'); // always follows a pointerup
  assert.deepEqual(area.sentNames(), ['press', 'release', 'press', 'click']);
});

test('a tap with a finger is a click, and a right-click or Escape reach the main process', () => {
  const area = loadHitArea();
  const touch = { ...press, pointerType: 'touch' };
  area.pointer('pointerdown', touch);
  area.pointer('pointerup', touch);
  area.pointer('pointerdown', { ...press, button: 2, buttons: 2 }); // the right button doesn't start a press
  let prevented = false;
  area.fire('contextmenu', { preventDefault: () => { prevented = true; } });
  area.fire('keydown', { key: 'Escape' });
  area.fire('keydown', { key: 'a' });
  assert.equal(prevented, true);
  assert.deepEqual(area.sentNames(), ['press', 'click', 'contextMenu', 'closeStats']);
});
