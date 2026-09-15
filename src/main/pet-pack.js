// Finds, reads and checks pet packs (a folder with pet.json and a .riv file). Pet packs can come from anyone,
// so every field the app uses is validated here and nothing else from pet.json reaches the app.
const fs = require('node:fs');
const path = require('node:path');
const { isPlainFolderName } = require('./config');
const { readJsonFile } = require('./json-file');
const { ZERO_INSETS } = require('./placement');

const TIMING_MAX_MS = 5000;
const FIDGET_MAX_MS = 60_000;
const INSET_MAX = 0.95;
const SIDES = ['top', 'right', 'bottom', 'left'];
const TIMING_KEYS = ['disappearMs', 'goodbyeMs', 'statsMergeMs'];
const QUIT_FALLBACK_MS = 2 * TIMING_MAX_MS + 2000; // quit even if the goodbye animation never finishes
const OBJECT_BINDINGS = ['usageProperties', 'usageColorProperties']; // { session, weekly, model } names
// Sent to the pet file as they are; other reactions go through an event that may pick from a list.
const DIRECT_REACTIONS = ['wake', 'appear', 'disappear'];

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const isText = (v) => typeof v === 'string' && v !== '';
const isTextList = (v) => Array.isArray(v) && v.every(isText);
const isFileName = (v) => isText(v) && !v.startsWith('.') && !/[\\/:*?"<>|]/.test(v);
const clampMs = (v, max) => Math.min(max, Math.max(0, v));

function sideInsets(value) {
  if (!isPlainObject(value)) return null;
  const out = {};
  for (const side of SIDES) {
    const n = value[side] ?? 0;
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > INSET_MAX) return null;
    out[side] = n;
  }
  return out;
}

// Fractions of the pet box per side, or separate { left, right } bounds for pets that really turn.
function insetsValue(value) {
  if (!isPlainObject(value)) return null;
  if (isPlainObject(value.left) || isPlainObject(value.right)) {
    const left = sideInsets(value.left);
    const right = sideInsets(value.right);
    return left && right ? { left, right } : null;
  }
  return sideInsets(value);
}

// Returns the checked manifest, or throws an Error whose message lists every problem.
function sanitizeManifest(manifest) {
  if (!isPlainObject(manifest)) throw new Error('pet.json must contain an object');
  const problems = [];
  const pet = {};
  const optional = (key, valid, expect, convert = (v) => v) => {
    if (manifest[key] === undefined) return;
    if (valid(manifest[key])) pet[key] = convert(manifest[key]);
    else problems.push(`"${key}" should be ${expect}`);
  };

  if (isFileName(manifest.file) && /\.riv$/i.test(manifest.file)) pet.file = manifest.file;
  else problems.push('"file" should be the name of a .riv file in the pet folder');

  const states = manifest.states;
  if (isPlainObject(states) && Object.keys(states).length && Object.values(states).every(Number.isFinite)) pet.states = { ...states };
  else problems.push('"states" should map pose names to numbers');

  optional('name', isText, 'text');
  optional('artboard', isText, 'text');
  optional('stateMachine', (v) => isText(v) || (isTextList(v) && v.length > 0), 'a state machine name');
  optional('artFacing', (v) => v === 1 || v === -1, '1 or -1');
  optional('maxGrowth', (v) => Number.isInteger(v) && v >= 0, 'a whole number of at least 0');
  optional('palettes', isTextList, 'a list of names');
  optional('trayIcon', isFileName, 'the name of an image file in the pet folder');
  // The renderer hands binding and reaction names straight to the Rive view model, and Rive swallows the throw a
  // wrong shape causes there, which silently breaks the pet. So each key is checked for the shape it is used with.
  const entries = (key, check) => {
    if (manifest[key] === undefined) return;
    if (!isPlainObject(manifest[key])) {
      problems.push(`"${key}" should be an object`);
      return;
    }
    const before = problems.length;
    for (const [name, value] of Object.entries(manifest[key])) {
      const expect = check(name, value);
      if (expect) problems.push(`"${key}.${name}" should be ${expect}`);
    }
    if (problems.length === before) pet[key] = structuredClone(manifest[key]);
  };
  entries('binding', (name, value) => {
    if (OBJECT_BINDINGS.includes(name)) {
      return isPlainObject(value) && Object.values(value).every(isText) ? null : 'an object of view-model property names';
    }
    return isText(value) ? null : 'a view-model property name';
  });
  entries('reactions', (name, value) => {
    if (DIRECT_REACTIONS.includes(name)) return isText(value) ? null : 'one trigger name';
    return isText(value) || (isTextList(value) && value.length > 0) ? null : 'a trigger name or a list of them';
  });
  optional(
    'fidgets',
    (v) => Array.isArray(v) && v.every((f) => isPlainObject(f) && isText(f.trigger) && Number.isFinite(f.ms)
      && (f.states === undefined || isTextList(f.states))),
    'a list of { "trigger", "ms", "states" } entries',
    (v) => v.map((f) => ({
      trigger: f.trigger, ms: clampMs(f.ms, FIDGET_MAX_MS), ...(f.states ? { states: [...f.states] } : {}),
    })),
  );
  optional('bodyInsets', (v) => !!insetsValue(v), `insets from 0 to ${INSET_MAX} per side`, insetsValue);
  optional(
    'stateInsets',
    (v) => isPlainObject(v) && Object.values(v).every((i) => !!insetsValue(i)),
    `an object of insets from 0 to ${INSET_MAX} per side`,
    (v) => Object.fromEntries(Object.entries(v).map(([state, i]) => [state, insetsValue(i)])),
  );

  // Timings delay hiding and quitting, so keep them short even if a pack asks for more.
  pet.timings = Object.fromEntries(TIMING_KEYS.map((key) => [key, 0]));
  if (manifest.timings !== undefined) {
    if (!isPlainObject(manifest.timings)) problems.push('"timings" should be an object of milliseconds');
    for (const key of TIMING_KEYS) {
      const value = manifest.timings?.[key];
      if (value === undefined) continue;
      if (Number.isFinite(value)) pet.timings[key] = clampMs(value, TIMING_MAX_MS);
      else problems.push(`"timings.${key}" should be a number of milliseconds`);
    }
  }

  if (problems.length) throw new Error(`pet.json has problems: ${problems.join('; ')}`);
  return pet;
}

// roots: [{ dir, urlBase, builtIn }] searched in order.
function loadPetPack(name, roots) {
  if (!isPlainFolderName(name)) throw new Error(`"${name}" is not a pet folder name`);
  const root = roots.find((r) => fs.existsSync(path.join(r.dir, name, 'pet.json')));
  if (!root) throw new Error(`no folder named "${name}" with a pet.json was found in ${roots.map((r) => r.dir).join(' or ')}`);
  const dir = path.join(root.dir, name);
  const read = readJsonFile(path.join(dir, 'pet.json'));
  if (read.status !== 'ok') throw new Error(`pet.json ${read.status === 'invalid' ? 'is not valid JSON' : 'could not be read'} (${read.error})`);
  const manifest = sanitizeManifest(read.value);
  if (!fs.existsSync(path.join(dir, manifest.file))) throw new Error(`${manifest.file} is missing from the pet folder`);
  return {
    ...manifest,
    bodyInsets: manifest.bodyInsets || ZERO_INSETS,
    folder: name,
    builtIn: !!root.builtIn,
    dir,
    url: `${root.urlBase}/${encodeURIComponent(name)}/${encodeURIComponent(manifest.file)}`,
  };
}

// The chosen pet, or the bundled fallback pet plus a notice saying why. Throws only if the bundled pet is broken.
function loadPetOrFallback(name, { roots, fallback }) {
  try {
    return { pet: loadPetPack(name, roots), notice: null };
  } catch (err) {
    if (name === fallback) throw err;
    const pet = loadPetPack(fallback, roots.filter((r) => r.builtIn));
    return { pet, notice: `The pet "${name}" could not be loaded, so the built-in pet is shown instead. ${err.message}` };
  }
}

// The renderer couldn't draw the pet: 'fallback' swaps a custom pet for the built-in one; when that isn't possible,
// 'ignoreMouse' (once) stops the invisible window from catching clicks; otherwise 'none'.
function petDrawFailurePlan({
  folder, fallback, alreadyFailed, fallbackBroken = false,
}) {
  if (folder !== fallback && !fallbackBroken) return 'fallback';
  return alreadyFailed ? 'none' : 'ignoreMouse';
}

// Delays for quitting: wave, then fade, then quit; fallbackMs quits anyway if those timers never get there.
function goodbyePlan(timings, { waved, fades }) {
  return {
    waveMs: waved ? timings.goodbyeMs || 0 : 0,
    fadeMs: fades ? timings.disappearMs || 0 : 0,
    fallbackMs: QUIT_FALLBACK_MS,
  };
}

module.exports = {
  TIMING_MAX_MS, sanitizeManifest, loadPetPack, loadPetOrFallback, petDrawFailurePlan, goodbyePlan,
};
