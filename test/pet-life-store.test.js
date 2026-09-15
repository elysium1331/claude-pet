const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openLifeStore } = require('../src/main/pet-life-store');
const { newLife } = require('../src/main/pet-life');

const t0 = new Date('2026-09-14T10:00:00Z').getTime();

function tempFile(t, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pet-life-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'pet-life.json');
  if (content !== undefined) fs.writeFileSync(file, content);
  return file;
}

const saved = JSON.stringify({ ...newLife(t0), happiness: 90, xp: 150, level: 2 });
const leveledUp = { ...newLife(t0), xp: 400, level: 3 };

test('a saved life is loaded and later saves replace it', (t) => {
  const file = tempFile(t, saved);
  const store = openLifeStore(file, { now: t0 });
  assert.equal(store.life.xp, 150);
  assert.equal(store.writable, true);
  assert.equal(store.notice, null);
  store.save(leveledUp);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), leveledUp);
});

test('with no file yet the pet starts fresh and saving creates the file', (t) => {
  const file = tempFile(t);
  const store = openLifeStore(file, { now: t0 });
  assert.deepEqual(store.life, newLife(t0));
  assert.equal(store.notice, null);
  store.save(leveledUp);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).xp, 400);
});

test('a damaged file is copied before a fresh pet may be saved over it', (t) => {
  for (const content of ['{"xp": 150,', 'null', '[1,2]']) {
    const file = tempFile(t, content);
    const store = openLifeStore(file, { now: t0 });
    assert.deepEqual(store.life, newLife(t0), content);
    assert.equal(store.writable, true);
    const copy = fs.readdirSync(path.dirname(file)).find((name) => name.startsWith('pet-life.json.broken-'));
    assert.equal(fs.readFileSync(path.join(path.dirname(file), copy), 'utf8'), content);
    assert.match(store.notice, /kept as/);
    store.save(leveledUp);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).xp, 400);
  }
});

test('a file that is briefly locked at launch is never overwritten that session', (t) => {
  const file = tempFile(t, saved);
  const readJson = () => ({ status: 'unreadable', error: 'EBUSY: resource busy or locked' });
  const store = openLifeStore(file, { now: t0, readJson });
  assert.deepEqual(store.life, newLife(t0));
  assert.equal(store.writable, false);
  assert.match(store.error, /EBUSY/);
  assert.match(store.notice, /won't be saved/);
  store.save(leveledUp);
  assert.equal(fs.readFileSync(file, 'utf8'), saved);
});

test('a damaged file that cannot be copied is left untouched', (t) => {
  const file = tempFile(t, '{"xp": 150,');
  const keepCopy = () => {
    throw new Error('ENOSPC: no space left on device');
  };
  const store = openLifeStore(file, { now: t0, keepCopy });
  assert.equal(store.writable, false);
  assert.match(store.error, /ENOSPC/);
  assert.match(store.notice, /won't be saved/);
  store.save(leveledUp);
  assert.equal(fs.readFileSync(file, 'utf8'), '{"xp": 150,');
});
