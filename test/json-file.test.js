const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readJsonFile, writeJsonAtomic, keepBrokenCopy } = require('../src/main/json-file');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pet-json-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('readJsonFile tells missing, invalid and valid files apart', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'a.json');
  assert.deepEqual(readJsonFile(file), { status: 'missing' });
  fs.writeFileSync(file, '{"a":1,}');
  assert.equal(readJsonFile(file).status, 'invalid');
  fs.writeFileSync(file, '\uFEFF{"a":1}'); // saved with a byte order mark
  assert.deepEqual(readJsonFile(file), { status: 'ok', value: { a: 1 } });
  assert.equal(readJsonFile(dir).status, 'unreadable'); // a folder, not a file
});

test('writeJsonAtomic replaces the file and leaves no temp file behind', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'nested', 'b.json');
  writeJsonAtomic(file, { a: 1 });
  writeJsonAtomic(file, { a: 2 }, { pretty: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { a: 2 });
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['b.json']);
});

test('writeJsonAtomic keeps the old file when the rename fails', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'c.json');
  fs.mkdirSync(file); // a folder in the way makes the rename fail
  assert.throws(() => writeJsonAtomic(file, { a: 1 }));
  assert.equal(fs.statSync(file).isDirectory(), true);
  assert.equal(fs.existsSync(`${file}.claude-pet.tmp`), false);
});

test('keepBrokenCopy saves one copy per distinct broken content', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, '{ oops');
  const first = keepBrokenCopy(file, new Date('2026-09-14T10:00:00Z'));
  assert.equal(path.basename(first), 'config.json.broken-2026-09-14T10-00-00-000Z');
  assert.equal(fs.readFileSync(first, 'utf8'), '{ oops');
  assert.equal(keepBrokenCopy(file, new Date('2026-09-14T11:00:00Z')), first);
  fs.writeFileSync(file, '{ different oops');
  assert.notEqual(keepBrokenCopy(file, new Date('2026-09-14T12:00:00Z')), first);
  assert.equal(fs.readFileSync(file, 'utf8'), '{ different oops'); // the original is left in place
});
