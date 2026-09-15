// Keeps the README, license and package metadata in step with the code, since pet authors and packagers rely on them.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
const readme = read('README.md');
const pkg = JSON.parse(read('package.json'));
const matches = (text, re) => [...text.matchAll(re)].map((m) => m[1]);
const unique = (list) => [...new Set(list)].sort();

function section(title) {
  const start = readme.indexOf(`\n## ${title}`);
  assert.notEqual(start, -1, `README has a "${title}" section`);
  const end = readme.indexOf('\n## ', start + 1);
  return readme.slice(start, end === -1 ? undefined : end);
}

const missingFrom = (text, names) => names.filter((name) => !text.includes(`\`${name}\``));

test('the license is MIT from elysium1331 everywhere it is stated', () => {
  const license = read('LICENSE');
  assert.match(license, /^MIT License/);
  assert.match(license, /Copyright \(c\) 2026 elysium1331/);
  assert.equal(pkg.license, 'MIT');
  assert.equal(pkg.author, 'elysium1331'); // electron-builder takes the exe's CompanyName and the installer's publisher from it
  assert.match(pkg.build.copyright, /elysium1331/);
  assert.ok(pkg.build.files.includes('LICENSE'), 'the license ships inside the app');
  const text = section('License');
  assert.match(text, /MIT/);
  assert.match(text, /LICENSE/);
  assert.doesNotMatch(text, /TBD/);
});

test('README "Make your own pet" documents every reaction the app plays', () => {
  const main = read('src', 'main', 'main.js');
  const names = unique([
    ...matches(main, /playEvent\('(\w+)'\)/g),
    ...matches(main, /pet\.reactions\??\.(\w+)/g),
  ]);
  assert.ok(names.length > 15, 'found the reactions in main.js');
  assert.deepEqual(missingFrom(section('Make your own pet'), names), []);
});

test('README "Make your own pet" documents every binding and manifest key the app reads', () => {
  const renderer = read('src', 'renderer', 'pet.js');
  const pack = read('src', 'main', 'pet-pack.js');
  const bindings = unique(matches(renderer, /binding\.(\w+)/g));
  const topLevel = unique([
    'file', 'states',
    ...matches(pack, /optional\(\s*'(\w+)'/g),
    ...matches(pack, /entries\('(\w+)'/g),
    ...matches(pack, /TIMING_KEYS = \[([^\]]+)\]/g).flatMap((list) => matches(list, /'(\w+)'/g)),
    'timings',
  ]);
  assert.ok(bindings.length > 15 && topLevel.length > 15, 'found the keys in the code');
  const text = section('Make your own pet');
  assert.deepEqual(missingFrom(text, bindings), []);
  assert.deepEqual(missingFrom(text, topLevel), []);
  assert.deepEqual(missingFrom(text, ['held']), [], 'the drag pose inset key');
  assert.doesNotMatch(text, /chips/, 'the pet has no usage chips any more');
});

test('README states the platform the app supports and the Node.js version only source builds need', () => {
  const requirements = section('Requirements');
  assert.doesNotMatch(requirements, /Node\.js/);
  assert.match(requirements, /macOS/);
  assert.match(section('Run from source'), /Node\.js/);
});

test('README documents the settings the app reads', () => {
  const { DEFAULTS } = require('../src/main/config');
  assert.deepEqual(missingFrom(section('Settings'), Object.keys(DEFAULTS)), []);
});

test('README describes the separate snapshot profile', () => {
  const dev = section('Development');
  assert.match(dev, /claude-pet-snapshot/);
  assert.match(dev, /--fake-usage=test\/fixtures\/usage-response\.json/);
  assert.ok(fs.existsSync(path.join(ROOT, 'test', 'fixtures', 'usage-response.json')));
});
