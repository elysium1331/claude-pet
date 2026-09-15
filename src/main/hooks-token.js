// A random secret that Claude Pet's hooks send with every event. 127.0.0.1 is shared by every account on the PC,
// but the token lives in this user's settings folders, so other accounts can't forge events or read the status.
const crypto = require('node:crypto');
const path = require('node:path');
const { readJsonFile, writeJsonAtomic } = require('./json-file');

const TOKEN_HEADER = 'X-Claude-Pet-Token';
// Letters and digits only: the token is written into a shell command in Claude Code's settings.
const TOKEN_PATTERN = /^[A-Za-z0-9]{32,128}$/;

function tokenPath(dir) {
  return path.join(dir, 'hooks-token.json');
}

function isValidToken(value) {
  return typeof value === 'string' && TOKEN_PATTERN.test(value);
}

function saveNewToken(file, randomBytes) {
  const token = randomBytes(32).toString('hex');
  try {
    writeJsonAtomic(file, { token }, { mode: 0o600 });
    return { token, persisted: true, error: null };
  } catch (err) {
    return { token, persisted: false, error: err };
  }
}

// Returns { token, persisted, error }. A token that isn't the saved one (the file couldn't be read or saved) still
// works for this session, but must never be written into Claude Code's settings: the next launch would use another.
function loadHookToken(dir, { randomBytes = crypto.randomBytes } = {}) {
  const file = tokenPath(dir);
  const read = readJsonFile(file);
  if (read.status === 'ok' && isValidToken(read.value?.token)) return { token: read.value.token, persisted: true, error: null };
  if (read.status === 'unreadable') {
    // Not replaced: the file may hold the token the installed hooks send, and only be locked for a moment.
    return { token: randomBytes(32).toString('hex'), persisted: false, error: new Error(`${file} could not be read (${read.error})`) };
  }
  return saveNewToken(file, randomBytes);
}

// For when another program may have seen the token. Returns { token, persisted, error }.
function renewHookToken(dir, { randomBytes = crypto.randomBytes } = {}) {
  return saveNewToken(tokenPath(dir), randomBytes);
}

// Compares hashes so the time taken says nothing about how much of a guess was right.
function tokenMatches(expected, given) {
  if (!isValidToken(expected) || typeof given !== 'string') return false;
  const hash = (value) => crypto.createHash('sha256').update(value).digest();
  return crypto.timingSafeEqual(hash(expected), hash(given));
}

module.exports = { TOKEN_HEADER, tokenPath, isValidToken, loadHookToken, renewHookToken, tokenMatches };
