// User settings live in Electron's userData folder (never in the repo).
const path = require('node:path');
const { readJsonFile, writeJsonAtomic, keepBrokenCopy } = require('./json-file');

const DEFAULTS = {
  pet: 'celestial-fox',
  pollMinutes: 2, // while Claude is running
  idlePollMinutes: 10, // while Claude is closed
  warnAtPercent: 85,
  loungeAfterMinutes: 3, // no pet interaction for this long -> lie down
  loungeOnTaskbar: true, // drift down onto the taskbar before lying down
  sleepWhenAwayMinutes: 10, // no keyboard/mouse input on the computer for this long -> sleep
  fidgets: true, // occasional idle animations, if the pet has them
  roam: 'taskbar', // 'off' | 'taskbar' | 'screen': occasionally take a little trip and come back
  roamMinMinutes: 10,
  roamMaxMinutes: 25,
  strollPose: 'float', // 'float' travels at normal size; 'walk' uses the compact walking gait
  hooksPort: 47821, // local port Claude Code hooks send events to
  celebrateAfterSeconds: 20, // only celebrate Claude Code turns that took at least this long
  hideHotkey: 'CommandOrControl+Alt+P', // null = no hotkey
  launchAtStartup: false,
  claudeProcessNames: ['claude.exe', 'claude'],
  credentialsPath: null, // null = .credentials.json in CLAUDE_CONFIG_DIR, or in ~/.claude
  scopedLimit: null, // which per-model weekly limit drives the third orb; null = first one reported
  lightBackdrop: 'auto', // true | false | 'auto' (follow the Windows light/dark setting)
  petScale: 1, // 0.8 small, 1 normal, 1.25 large, 1.5 extra large
  taskbarPose: 'float', // 'float' keeps its normal size on the taskbar; 'sit' sits (more compact)
  ambientMotion: true, // random ear twitches and tail drift, if the pet supports them
  palette: 0, // color theme index, if the pet has themes
  nightMode: 'auto', // true | false | 'auto' (softer glow between nightStartHour and nightEndHour)
  nightStartHour: 22,
  nightEndHour: 7,
  petPosition: null,
};

// A pet is chosen by folder name only, so config.pet can never point outside the pets folders.
function isPlainFolderName(name) {
  return typeof name === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name);
}

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const nonEmptyString = (v) => typeof v === 'string' && v.trim() !== '';

function number(min, max = Infinity, integer = false) {
  const range = max === Infinity ? `at least ${min}` : `from ${min} to ${max}`;
  return {
    valid: (v) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max && (!integer || Number.isInteger(v)),
    expect: `${integer ? 'a whole number' : 'a number'} ${range}`,
  };
}

function oneOf(...options) {
  return { valid: (v) => options.includes(v), expect: `one of ${options.map((o) => JSON.stringify(o)).join(', ')}` };
}

const boolean = { valid: (v) => typeof v === 'boolean', expect: 'true or false' };
const textOrNull = { valid: (v) => v === null || nonEmptyString(v), expect: 'text or null' };

const RULES = {
  pet: { valid: isPlainFolderName, expect: 'a pet folder name (letters, digits, ".", "_" or "-")' },
  pollMinutes: number(1, 1440),
  idlePollMinutes: number(1, 1440),
  warnAtPercent: number(1, 100),
  loungeAfterMinutes: number(0),
  loungeOnTaskbar: boolean,
  sleepWhenAwayMinutes: number(1),
  fidgets: boolean,
  roam: oneOf('off', 'taskbar', 'screen'),
  roamMinMinutes: number(1),
  roamMaxMinutes: number(1),
  strollPose: oneOf('float', 'walk'),
  hooksPort: number(1024, 65535, true),
  celebrateAfterSeconds: number(0),
  hideHotkey: textOrNull,
  launchAtStartup: boolean,
  claudeProcessNames: {
    valid: (v) => Array.isArray(v) && v.length > 0 && v.every(nonEmptyString),
    expect: 'a list of process names',
  },
  credentialsPath: textOrNull,
  scopedLimit: textOrNull,
  lightBackdrop: oneOf(true, false, 'auto'),
  petScale: number(0.6, 2),
  taskbarPose: oneOf('float', 'sit'),
  ambientMotion: boolean,
  palette: number(0, Infinity, true),
  nightMode: oneOf(true, false, 'auto'),
  nightStartHour: number(0, 24),
  nightEndHour: number(0, 24),
  petPosition: {
    valid: (v) => v === null || (isPlainObject(v) && Number.isFinite(v.x) && Number.isFinite(v.y)),
    expect: 'null or { "x": number, "y": number }',
  },
};

// Settings the app saves for itself; they have no default and are dropped when wrong.
const INTERNAL_RULES = {
  lastGreetDate: { valid: (v) => typeof v === 'string', expect: 'a date' },
};

// Every known setting with the wrong type or range falls back to its default; unknown keys are kept.
// Returns { config, problems: [{ key, message }] }.
function sanitizeConfig(raw) {
  const config = { ...DEFAULTS, ...raw };
  const problems = [];
  for (const [key, rule] of Object.entries(RULES)) {
    if (rule.valid(config[key])) continue;
    problems.push({ key, message: `${key} should be ${rule.expect}, so the default ${JSON.stringify(DEFAULTS[key])} is used` });
    config[key] = DEFAULTS[key];
  }
  for (const [key, rule] of Object.entries(INTERNAL_RULES)) {
    if (!(key in config) || rule.valid(config[key])) continue;
    problems.push({ key, message: `${key} should be ${rule.expect}, so it is ignored` });
    delete config[key];
  }
  return { config, problems };
}

function configPath(dir) {
  return path.join(dir, 'config.json');
}

// Returns { config, problems, writable, error, brokenCopy }. When the file can't be used, the pet runs on defaults
// and `writable` is false: nothing may be saved over the user's file that session.
function loadConfig(dir, now = new Date()) {
  const file = configPath(dir);
  const read = readJsonFile(file);
  if (read.status === 'missing') {
    const config = { ...DEFAULTS };
    try {
      writeJsonAtomic(file, config, { pretty: true }); // first run: write defaults so users can find and edit them
    } catch (err) {
      console.warn('[config] could not write defaults:', err.message);
    }
    return { config, problems: [], writable: true, error: null, brokenCopy: null };
  }
  if (read.status === 'ok' && isPlainObject(read.value)) {
    return { ...sanitizeConfig(read.value), writable: true, error: null, brokenCopy: null };
  }

  let error;
  let brokenCopy = null;
  if (read.status === 'unreadable') {
    error = `config.json could not be read (${read.error})`;
  } else {
    error = read.status === 'invalid'
      ? `config.json is not valid JSON (${read.error})`
      : 'config.json does not contain a settings object';
    try {
      brokenCopy = keepBrokenCopy(file, now);
    } catch (err) {
      console.warn('[config] could not copy the broken file:', err.message);
    }
  }
  return { config: { ...DEFAULTS }, problems: [], writable: false, error, brokenCopy };
}

// Saves only the settings the app changed, merged into what is on disk now, so hand edits made while the
// pet runs are kept. Throws (and writes nothing) if the file on disk can't be read or parsed.
function saveConfigChanges(dir, changes) {
  const file = configPath(dir);
  const read = readJsonFile(file);
  if (read.status === 'unreadable') throw new Error(`${file} could not be read (${read.error}), so it was left untouched`);
  if (read.status === 'invalid') throw new Error(`${file} is not valid JSON, so it was left untouched`);
  if (read.status === 'ok' && !isPlainObject(read.value)) throw new Error(`${file} is not a settings object, so it was left untouched`);
  const current = read.status === 'ok' ? read.value : {};
  writeJsonAtomic(file, { ...current, ...changes }, { pretty: true });
}

// Whether the OS startup entry should be on at launch, from loadConfig's result. null means leave it as it is:
// when config.json (or its launchAtStartup) couldn't be used, the default false would remove an entry the file asks for.
function loginItemAtLaunch(loaded) {
  if (!loaded.writable || loaded.problems.some((p) => p.key === 'launchAtStartup')) return null;
  return !!loaded.config.launchAtStartup;
}

module.exports = {
  DEFAULTS, sanitizeConfig, loadConfig, saveConfigChanges, configPath, isPlainFolderName, loginItemAtLaunch,
};
