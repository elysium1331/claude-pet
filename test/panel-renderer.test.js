// Runs the stats panel script with a fake page and host bridge, to check how it opens, closes and changes sides.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SCRIPT = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'panel.js'), 'utf8');

function loadPanel() {
  const host = {};
  const classes = new Set();
  const changes = []; // body class lists, in order, each time one changes
  let reflows = 0;
  const node = () => ({
    append() {},
    replaceChildren() {},
    addEventListener() {},
    style: { setProperty() {} },
    get offsetWidth() {
      reflows += 1;
      return 244;
    },
    offsetHeight: 120,
  });
  const record = () => changes.push([...classes].sort().join(' '));
  const context = {
    document: {
      getElementById: node,
      createElement: node,
      createElementNS: node,
      body: {
        classList: {
          add: (...names) => { names.forEach((n) => classes.add(n)); record(); },
          remove: (...names) => { names.forEach((n) => classes.delete(n)); record(); },
          contains: (name) => classes.has(name),
        },
      },
    },
    window: {
      panelHost: {
        onView: () => {},
        onOpen: (fn) => { host.open = fn; },
        onClose: (fn) => { host.close = fn; },
        clicked() {},
        reportSize() {},
      },
    },
    ResizeObserver: class { observe() {} },
  };
  vm.createContext(context);
  vm.runInContext(SCRIPT, context);
  return {
    host, classes, changes, reflows: () => reflows,
  };
}

test('the panel grows from the side nearest the pet when it opens', () => {
  const panel = loadPanel();
  panel.host.open('below');
  assert.deepEqual([...panel.classes].sort(), ['below', 'open']);
  assert.equal(panel.reflows(), 1);
  panel.host.close();
  assert.deepEqual([...panel.classes].sort(), ['below']);
  panel.host.open('above');
  assert.deepEqual([...panel.classes].sort(), ['above', 'open']);
  assert.equal(panel.reflows(), 2);
});

test('an open panel that moves to the other side of the pet switches edges without growing again', () => {
  const panel = loadPanel();
  panel.host.open('above');
  const before = panel.changes.length;
  panel.host.open('below');
  assert.deepEqual([...panel.classes].sort(), ['below', 'open']);
  assert.equal(panel.reflows(), 1, 'no restart of the grow animation');
  assert.ok(panel.changes.slice(before).every((list) => list.includes('open')), 'it never stops being open');
  panel.host.close();
  assert.deepEqual([...panel.classes], ['below'], 'and shrinks back toward the pet on its new side');
});
