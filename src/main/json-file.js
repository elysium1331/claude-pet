// Reading and writing the app's own JSON files so a crash, a typo or a locked file never loses what was saved.
const fs = require('node:fs');
const path = require('node:path');

// { status: 'ok', value } | { status: 'missing' } | { status: 'invalid', error } | { status: 'unreadable', error }
function readJsonFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { status: 'missing' };
    return { status: 'unreadable', error: err.message };
  }
  try {
    // Some editors save UTF-8 with a byte order mark, which JSON.parse rejects.
    return { status: 'ok', value: JSON.parse(text.replace(/^\uFEFF/, '')) };
  } catch (err) {
    return { status: 'invalid', error: err.message };
  }
}

// Write to a temp file and rename it over the target, so a crash mid-write leaves the old file intact.
function writeJsonAtomic(file, value, { pretty = false } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.claude-pet.tmp`;
  fs.writeFileSync(tmp, pretty ? `${JSON.stringify(value, null, 2)}\n` : JSON.stringify(value));
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

function stampFor(now) {
  return now.toISOString().replace(/[:.]/g, '-');
}

// Saves a copy of a file that couldn't be parsed (<file>.broken-<stamp>) before the app works around it.
// Reuses an existing identical copy, so relaunching with the same broken file doesn't pile up copies.
function keepBrokenCopy(file, now = new Date()) {
  const content = fs.readFileSync(file);
  const dir = path.dirname(file);
  const prefix = `${path.basename(file)}.broken-`;
  for (const name of fs.readdirSync(dir)) {
    if (!name.startsWith(prefix)) continue;
    const existing = path.join(dir, name);
    try {
      if (fs.readFileSync(existing).equals(content)) return existing;
    } catch {
      // unreadable copy: ignore it
    }
  }
  const copy = `${file}.broken-${stampFor(now)}`;
  fs.writeFileSync(copy, content);
  return copy;
}

module.exports = { readJsonFile, writeJsonAtomic, keepBrokenCopy };
