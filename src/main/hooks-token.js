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

// Returns { token, error }. A token that couldn't be saved still works this session; the hooks follow the new
// token on the next launch.
function loadHookToken(dir, { randomBytes = crypto.randomBytes } = {}) {
  const file = tokenPath(dir);
  const read = readJsonFile(file);
  if (read.status === 'ok' && isValidToken(read.value?.token)) return { token: read.value.token, error: null };
  const token = randomBytes(32).toString('hex');
  if (read.status === 'unreadable') return { token, error: new Error(`${file} could not be read (${read.error})`) };
  try {
    writeJsonAtomic(file, { token }, { mode: 0o600 });
    return { token, error: null };
  } catch (err) {
    return { token, error: err };
  }
}

// Compares hashes so the time taken says nothing about how much of a guess was right.
function tokenMatches(expected, given) {
  if (!isValidToken(expected) || typeof given !== 'string') return false;
  const hash = (value) => crypto.createHash('sha256').update(value).digest();
  return crypto.timingSafeEqual(hash(expected), hash(given));
}

module.exports = { TOKEN_HEADER, tokenPath, isValidToken, loadHookToken, tokenMatches };
