const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { isClaudeRunning, DETECT_TIMEOUT_MS } = require('../src/main/claude-process');

const listing = process.platform === 'win32'
  ? '"System Idle Process","0","Services","0","8 K"\r\n"Claude.exe","1234","Console","1","90,000 K"\r\n'
  : '/sbin/init\n/Applications/Claude.app/Contents/MacOS/Claude\n';

test('isClaudeRunning matches process names case-insensitively, with a timeout on the listing', async () => {
  let options;
  const run = (_cmd, _args, opts, callback) => {
    options = opts;
    callback(null, listing);
  };
  assert.equal(await isClaudeRunning(process.platform === 'win32' ? ['claude.exe'] : ['claude'], { run }), true);
  assert.equal(options.timeout, DETECT_TIMEOUT_MS);
  assert.equal(await isClaudeRunning(['notepad.exe'], { run }), false);
  assert.equal(await isClaudeRunning('claude.exe', { run }), false); // not a list: nothing to match
});

test('isClaudeRunning gives up on a hung process listing and assumes Claude is running', async () => {
  // a child that never exits stands in for a hung tasklist
  const run = (_cmd, _args, opts, callback) => execFile(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], opts, callback);
  const started = Date.now();
  assert.equal(await isClaudeRunning(['claude.exe'], { run, timeoutMs: 200 }), true);
  assert.ok(Date.now() - started < 5000);
});
