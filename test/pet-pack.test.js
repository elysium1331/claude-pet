const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  TIMING_MAX_MS, sanitizeManifest, loadPetPack, loadPetOrFallback,
} = require('../src/main/pet-pack');
const { fidgetsFor, insetsForState, resolveState } = require('../src/main/behavior');

const ROOT = path.join(__dirname, '..');
const minimal = { file: 'pet.riv', states: { idle: 0, sleeping: 1 } };

test('the bundled celestial fox passes validation unchanged', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'pets', 'celestial-fox', 'pet.json'), 'utf8'));
  const pet = sanitizeManifest(manifest);
  for (const key of ['file', 'artboard', 'stateMachine', 'artFacing', 'binding', 'maxGrowth', 'palettes', 'states',
    'reactions', 'timings', 'fidgets', 'bodyInsets', 'stateInsets']) {
    assert.deepEqual(pet[key], manifest[key], key);
  }
});

test('sanitizeManifest fills in timings and needs only a file and states', () => {
  const pet = sanitizeManifest(minimal);
  assert.deepEqual(pet, { ...minimal, timings: { disappearMs: 0, goodbyeMs: 0, statsMergeMs: 0 } });
});

test('sanitizeManifest rejects malformed fields that would throw in the app, naming each one', () => {
  const cases = [
    [{ ...minimal, states: 'x' }, /"states"/],
    [{ file: 'pet.riv' }, /"states"/],
    [{ ...minimal, states: { idle: 'zero' } }, /"states"/],
    [{ ...minimal, file: '../other/pet.riv' }, /"file"/],
    [{ ...minimal, file: 'pet.png' }, /"file"/],
    [{ ...minimal, fidgets: {} }, /"fidgets"/],
    [{ ...minimal, fidgets: [{ trigger: 'yawn', ms: 'long' }] }, /"fidgets"/],
    [{ ...minimal, palettes: 'blue' }, /"palettes"/],
    [{ ...minimal, bodyInsets: { right: null, left: { top: 0.1 } } }, /"bodyInsets"/],
    [{ ...minimal, bodyInsets: { right: { top: 0.1 } } }, /"bodyInsets"/], // missing the left bounds
    [{ ...minimal, bodyInsets: { top: '0.1' } }, /"bodyInsets"/],
    [{ ...minimal, stateInsets: { lounging: { top: 2 } } }, /"stateInsets"/],
    [{ ...minimal, reactions: { wake: 5 } }, /"reactions"/],
    [{ ...minimal, binding: { stateProperty: ['state'] } }, /"binding"/],
    [{ ...minimal, trayIcon: '..\\secret.png' }, /"trayIcon"/],
    [{ ...minimal, timings: { goodbyeMs: 'soon' } }, /timings\.goodbyeMs/],
    [null, /object/],
  ];
  for (const [manifest, message] of cases) assert.throws(() => sanitizeManifest(manifest), message, JSON.stringify(manifest));
  assert.throws(() => sanitizeManifest({ fidgets: {} }), (err) => /"file"/.test(err.message) && /"states"/.test(err.message) && /"fidgets"/.test(err.message));
});

test('sanitizeManifest clamps timings so a pack cannot stall hiding or quitting', () => {
  const pet = sanitizeManifest({ ...minimal, timings: { goodbyeMs: 2147483647, disappearMs: -50, statsMergeMs: 400 } });
  assert.deepEqual(pet.timings, { goodbyeMs: TIMING_MAX_MS, disappearMs: 0, statsMergeMs: 400 });
  assert.equal(sanitizeManifest({ ...minimal, fidgets: [{ trigger: 'yawn', ms: 1e12 }] }).fidgets[0].ms, 60_000);
});

test('checked manifests work with the behavior helpers', () => {
  const pet = sanitizeManifest({
    ...minimal,
    fidgets: [{ trigger: 'yawn', ms: 2000, extra: 'dropped' }],
    bodyInsets: { top: 0.1 },
  });
  assert.deepEqual(fidgetsFor(pet, 'idle'), [{ trigger: 'yawn', ms: 2000 }]);
  assert.deepEqual(insetsForState(pet, 'idle', -1), { top: 0.1, right: 0, bottom: 0, left: 0 });
  assert.equal(resolveState(pet, 'working'), 'idle');
});

function makeRoots(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pet-packs-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const roots = [
    { dir: path.join(base, 'bundled'), urlBase: 'app://bundle/pets', builtIn: true },
    { dir: path.join(base, 'user'), urlBase: 'app://bundle/user-pets', builtIn: false },
  ];
  const addPet = (root, name, manifest, { riv = true } = {}) => {
    const dir = path.join(root.dir, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'pet.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest));
    if (riv) fs.writeFileSync(path.join(dir, 'pet.riv'), 'riv');
  };
  return { roots, addPet };
}

test('loadPetPack finds bundled pets first, then pets in the user folder', (t) => {
  const { roots, addPet } = makeRoots(t);
  addPet(roots[0], 'fox', minimal);
  addPet(roots[1], 'fox', { ...minimal, name: 'shadowing copy' });
  addPet(roots[1], 'my pet.v2', minimal);
  const fox = loadPetPack('fox', roots);
  assert.equal(fox.builtIn, true);
  assert.equal(fox.url, 'app://bundle/pets/fox/pet.riv');
  assert.equal(fox.name, undefined);
  assert.throws(() => loadPetPack('my pet.v2', roots), /not a pet folder name/);
  addPet(roots[1], 'owl', minimal);
  const owl = loadPetPack('owl', roots);
  assert.equal(owl.builtIn, false);
  assert.equal(owl.dir, path.join(roots[1].dir, 'owl'));
  assert.equal(owl.url, 'app://bundle/user-pets/owl/pet.riv');
});

test('loadPetPack explains missing folders, broken JSON and a missing .riv file', (t) => {
  const { roots, addPet } = makeRoots(t);
  assert.throws(() => loadPetPack('nope', roots), /no folder named "nope"/);
  assert.throws(() => loadPetPack('../bundled', roots), /not a pet folder name/);
  addPet(roots[1], 'comma', '{"file":"pet.riv",}');
  assert.throws(() => loadPetPack('comma', roots), /not valid JSON/);
  addPet(roots[1], 'norive', minimal, { riv: false });
  assert.throws(() => loadPetPack('norive', roots), /pet\.riv is missing/);
});

test('loadPetOrFallback shows the bundled pet with a notice when the chosen one is missing or invalid', (t) => {
  const { roots, addPet } = makeRoots(t);
  addPet(roots[0], 'celestial-fox', minimal);
  addPet(roots[1], 'broken', { ...minimal, fidgets: {} });
  assert.deepEqual(loadPetOrFallback('celestial-fox', { roots, fallback: 'celestial-fox' }).notice, null);
  for (const name of ['broken', 'missing']) {
    const { pet, notice } = loadPetOrFallback(name, { roots, fallback: 'celestial-fox' });
    assert.equal(pet.folder, 'celestial-fox');
    assert.equal(pet.builtIn, true);
    assert.match(notice, new RegExp(`"${name}" could not be loaded`));
  }
  // with the bundled pet itself broken there is nothing to fall back to
  fs.writeFileSync(path.join(roots[0].dir, 'celestial-fox', 'pet.json'), '{');
  assert.throws(() => loadPetOrFallback('broken', { roots, fallback: 'celestial-fox' }), /not valid JSON/);
});
