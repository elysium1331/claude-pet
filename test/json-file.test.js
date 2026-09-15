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

test('writeJsonAtomic replaces a temp file left by a crash instead of writing through it', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'd.json');
  const other = path.join(dir, 'other.json');
  fs.writeFileSync(other, 'untouched');
  fs.linkSync(other, `${file}.claude-pet.tmp`); // left over, and linked to another file
  writeJsonAtomic(file, { a: 1 });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { a: 1 });
  assert.equal(fs.readFileSync(other, 'utf8'), 'untouched');
  assert.equal(fs.existsSync(`${file}.claude-pet.tmp`), false);
});

test('writeJsonAtomic gives a new file the requested permissions even when a temp file was left over', {
  skip: process.platform === 'win32' && 'Windows does not use permission bits',
}, (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'e.json');
  fs.writeFileSync(`${file}.claude-pet.tmp`, 'old', { mode: 0o644 });
  writeJsonAtomic(file, { a: 1 }, { mode: 0o600 });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('writeJsonAtomic leaves no half-written temp file when writing it fails', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'f.json');
  fs.writeFileSync(file, '{"a":1}');
  const { writeFileSync } = fs;
  t.mock.method(fs, 'writeFileSync', (target, text, options) => {
    writeFileSync(target, String(text).slice(0, 3), options);
    throw Object.assign(new Error('no space left'), { code: 'ENOSPC' });
  });
  assert.throws(() => writeJsonAtomic(file, { a: 2 }), /no space left/);
  assert.deepEqual(fs.readdirSync(dir), ['f.json']);
  assert.equal(fs.readFileSync(file, 'utf8'), '{"a":1}');
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
