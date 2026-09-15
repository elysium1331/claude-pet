const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  DEFAULTS, sanitizeConfig, loadConfig, saveConfigChanges, configPath, isPlainFolderName,
} = require('../src/main/config');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pet-config-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const readFile = (dir) => JSON.parse(fs.readFileSync(configPath(dir), 'utf8'));

test('sanitizeConfig keeps valid settings and unknown keys as they are', () => {
  const raw = {
    ...DEFAULTS, pollMinutes: 5, roam: 'off', hideHotkey: null, petPosition: { x: -300, y: 900 }, myNote: 'hi',
  };
  const { config, problems } = sanitizeConfig(raw);
  assert.deepEqual(problems, []);
  assert.deepEqual(config, raw);
  assert.deepEqual(sanitizeConfig({}).config, DEFAULTS);
});

test('sanitizeConfig resets each wrong type or out-of-range value to its default and says which', () => {
  const { config, problems } = sanitizeConfig({
    pollMinutes: 0,
    idlePollMinutes: null,
    warnAtPercent: '85',
    loungeAfterMinutes: -1,
    sleepWhenAwayMinutes: 0,
    roamMinMinutes: 0,
    roamMaxMinutes: Number.NaN,
    roam: 'everywhere',
    hooksPort: 70000,
    celebrateAfterSeconds: -5,
    hideHotkey: '',
    launchAtStartup: 'yes',
    claudeProcessNames: 'claude.exe',
    credentialsPath: 42,
    scopedLimit: 3,
    lightBackdrop: 'dark',
    petScale: 9,
    palette: 1.5,
    nightMode: 'sometimes',
    nightStartHour: 25,
    petPosition: { x: 'left', y: 3 },
    pet: '../elsewhere',
    lastGreetDate: 20260914,
  });
  const keys = [
    'pollMinutes', 'idlePollMinutes', 'warnAtPercent', 'loungeAfterMinutes', 'sleepWhenAwayMinutes', 'roamMinMinutes',
    'roamMaxMinutes', 'roam', 'hooksPort', 'celebrateAfterSeconds', 'hideHotkey', 'launchAtStartup', 'claudeProcessNames',
    'credentialsPath', 'scopedLimit', 'lightBackdrop', 'petScale', 'palette', 'nightMode', 'nightStartHour', 'petPosition', 'pet',
  ];
  for (const key of keys) assert.deepEqual(config[key], DEFAULTS[key], key);
  assert.deepEqual(problems.map((p) => p.key).sort(), [...keys, 'lastGreetDate'].sort());
  assert.ok(problems.every((p) => typeof p.message === 'string' && p.message.includes(p.key)));
  assert.equal('lastGreetDate' in config, false);
  // a fractional or privileged port is not a port
  assert.equal(sanitizeConfig({ hooksPort: 47821.5 }).config.hooksPort, DEFAULTS.hooksPort);
  assert.equal(sanitizeConfig({ hooksPort: 80 }).config.hooksPort, DEFAULTS.hooksPort);
  assert.equal(sanitizeConfig({ claudeProcessNames: ['claude.exe', 7] }).config.claudeProcessNames, DEFAULTS.claudeProcessNames);
});

test('isPlainFolderName accepts folder names only', () => {
  for (const ok of ['celestial-fox', 'my_pet.v2', 'Fox2']) assert.equal(isPlainFolderName(ok), true, ok);
  for (const bad of ['', '.', '..', '../x', 'a/b', 'a\\b', 'C:', '.hidden', 'x'.repeat(65), null, 3]) {
    assert.equal(isPlainFolderName(bad), false, String(bad));
  }
});

test('loadConfig writes the defaults on first run', (t) => {
  const dir = tempDir(t);
  const loaded = loadConfig(dir);
  assert.deepEqual(loaded.config, DEFAULTS);
  assert.equal(loaded.writable, true);
  assert.deepEqual(readFile(dir), DEFAULTS);
});

test('loadConfig keeps a broken config.json, uses defaults and never overwrites it that session', (t) => {
  const dir = tempDir(t);
  const broken = '{"pollMinutes":5,"roam":"off","scopedLimit":"Opus",}';
  fs.writeFileSync(configPath(dir), broken);
  const loaded = loadConfig(dir, new Date('2026-09-14T10:00:00Z'));
  assert.deepEqual(loaded.config, DEFAULTS);
  assert.equal(loaded.writable, false);
  assert.match(loaded.error, /not valid JSON/);
  assert.equal(fs.readFileSync(loaded.brokenCopy, 'utf8'), broken);
  assert.equal(fs.readFileSync(configPath(dir), 'utf8'), broken);
});

test('loadConfig treats JSON that is not an object as broken', (t) => {
  const dir = tempDir(t);
  fs.writeFileSync(configPath(dir), '[1, 2]');
  const loaded = loadConfig(dir);
  assert.equal(loaded.writable, false);
  assert.ok(loaded.brokenCopy);
});

test('loadConfig fills in missing keys and reports invalid ones without touching the file', (t) => {
  const dir = tempDir(t);
  fs.writeFileSync(configPath(dir), JSON.stringify({ pollMinutes: 0, roam: 'off' }));
  const loaded = loadConfig(dir);
  assert.equal(loaded.writable, true);
  assert.equal(loaded.config.pollMinutes, DEFAULTS.pollMinutes);
  assert.equal(loaded.config.roam, 'off');
  assert.equal(loaded.config.hooksPort, DEFAULTS.hooksPort);
  assert.deepEqual(loaded.problems.map((p) => p.key), ['pollMinutes']);
  assert.deepEqual(readFile(dir), { pollMinutes: 0, roam: 'off' });
});

test('saveConfigChanges merges only the changed keys into the file, keeping edits made while the pet runs', (t) => {
  const dir = tempDir(t);
  loadConfig(dir); // first run writes defaults
  // the user edits the file by hand while the pet is running
  fs.writeFileSync(configPath(dir), JSON.stringify({ ...DEFAULTS, roam: 'off', pollMinutes: 5, myNote: 'keep me' }, null, 2));
  saveConfigChanges(dir, { petPosition: { x: 10, y: 20 } });
  const saved = readFile(dir);
  assert.equal(saved.roam, 'off');
  assert.equal(saved.pollMinutes, 5);
  assert.equal(saved.myNote, 'keep me');
  assert.deepEqual(saved.petPosition, { x: 10, y: 20 });
  assert.equal(fs.readdirSync(dir).some((name) => name.endsWith('.tmp')), false);
});

test('saveConfigChanges refuses to overwrite a file that became unparseable', (t) => {
  const dir = tempDir(t);
  fs.writeFileSync(configPath(dir), '{ half an edit');
  assert.throws(() => saveConfigChanges(dir, { palette: 2 }), /not valid JSON/);
  assert.equal(fs.readFileSync(configPath(dir), 'utf8'), '{ half an edit');
});

test('saveConfigChanges recreates a deleted file', (t) => {
  const dir = tempDir(t);
  saveConfigChanges(dir, { palette: 2 });
  assert.deepEqual(readFile(dir), { palette: 2 });
});
