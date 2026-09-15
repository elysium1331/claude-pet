const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  loadHookToken, tokenMatches, tokenPath, isValidToken,
} = require('../src/main/hooks-token');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pet-token-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('loadHookToken creates a letters-and-digits token once and then keeps it', (t) => {
  const dir = tempDir(t);
  const first = loadHookToken(dir);
  assert.equal(first.error, null);
  assert.match(first.token, /^[A-Za-z0-9]{64}$/);
  assert.equal(loadHookToken(dir).token, first.token);
  assert.deepEqual(JSON.parse(fs.readFileSync(tokenPath(dir), 'utf8')), { token: first.token });
});

test('a damaged or hand-edited token file gets a fresh token', (t) => {
  const dir = tempDir(t);
  for (const content of ['{ nope', '{"token":"has spaces & quotes\\""}', '{"token":"short"}', 'null']) {
    fs.writeFileSync(tokenPath(dir), content);
    const { token, error } = loadHookToken(dir);
    assert.equal(error, null);
    assert.ok(isValidToken(token), content);
    assert.equal(loadHookToken(dir).token, token, content);
  }
});

test('a token that cannot be saved is still returned, with the error', (t) => {
  const dir = tempDir(t);
  const blocked = path.join(dir, 'not-a-folder');
  fs.writeFileSync(blocked, 'a file where the settings folder should be');
  const { token, error } = loadHookToken(blocked);
  assert.ok(isValidToken(token));
  assert.ok(error);
});

test('tokenMatches accepts only the exact token', () => {
  const token = 'a'.repeat(40);
  assert.equal(tokenMatches(token, token), true);
  assert.equal(tokenMatches(token, `${token}b`), false);
  assert.equal(tokenMatches(token, 'A'.repeat(40)), false);
  assert.equal(tokenMatches(token, ''), false);
  assert.equal(tokenMatches(token, undefined), false);
  assert.equal(tokenMatches(token, ['a']), false);
  assert.equal(tokenMatches('', ''), false); // no token configured never matches
});
