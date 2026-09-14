const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyClicks, StrokeDetector, edgeBump } = require('../src/main/gestures');

test('classifyClicks: one click opens stats, two do a trick, three or more tickle', () => {
  assert.equal(classifyClicks(1), 'stats');
  assert.equal(classifyClicks(2), 'trick');
  assert.equal(classifyClicks(3), 'tickle');
  assert.equal(classifyClicks(7), 'tickle');
  assert.equal(classifyClicks(0), null);
});

test('StrokeDetector spots a back-and-forth rub, but not a cursor passing by', () => {
  const rub = new StrokeDetector({ minTravel: 6, reversals: 4, windowMs: 1200, cooldownMs: 4000 });
  // a single sweep across the pet
  let hits = [0, 20, 40, 60, 80].map((x, i) => rub.add(x, 1000 + i * 30));
  assert.ok(hits.every((h) => h === false));

  // rubbing: 20px back and forth
  const xs = [80, 60, 80, 60, 80, 60];
  hits = xs.map((x, i) => rub.add(x, 2000 + i * 80));
  assert.equal(hits.filter(Boolean).length, 1);

  // cooldown: more rubbing right away doesn't count again
  hits = [80, 60, 80, 60, 80].map((x, i) => rub.add(x, 2600 + i * 80));
  assert.ok(hits.every((h) => h === false));
});

test('StrokeDetector ignores slow wiggles spread over too long', () => {
  const rub = new StrokeDetector({ minTravel: 6, reversals: 4, windowMs: 1200, cooldownMs: 0 });
  const hits = [0, 20, 0, 20, 0, 20].map((x, i) => rub.add(x, i * 600));
  assert.ok(hits.every((h) => h === false));
});

test('StrokeDetector with larger travel works as a shake detector for dragging', () => {
  const shake = new StrokeDetector({ minTravel: 40, reversals: 5, windowMs: 1500, cooldownMs: 0 });
  // small jitters while dragging are not a shake
  assert.ok([0, 10, 0, 10, 0, 10, 0].map((x, i) => shake.add(x, i * 50)).every((h) => !h));
  const hits = [0, 80, 0, 80, 0, 80, 0].map((x, i) => shake.add(x, 1000 + i * 90));
  assert.equal(hits.filter(Boolean).length, 1);
});

test('edgeBump reports which edge stopped the pet when it was pushed well past it', () => {
  assert.equal(edgeBump({ x: -40, y: 300 }, { x: 0, y: 300 }), 'left');
  assert.equal(edgeBump({ x: 2000, y: 300 }, { x: 1780, y: 300 }), 'right');
  assert.equal(edgeBump({ x: 500, y: -60 }, { x: 500, y: 0 }), 'top');
  assert.equal(edgeBump({ x: -5, y: 300 }, { x: 0, y: 300 }), null); // just touching
  // pushing down onto the taskbar is a landing, not a bonk
  assert.equal(edgeBump({ x: 500, y: 1200 }, { x: 500, y: 900 }), null);
});
