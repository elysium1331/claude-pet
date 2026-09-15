const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  addPetHooks, hooksDetails, readHooksState, upgradeHooks, HOOK_EVENTS,
} = require('../src/main/hooks-installer');
const {
  startupHooksPlan, hooksAction, hooksMenu, portProblem,
} = require('../src/main/hooks-plan');

const TOKEN = 'abc123'.repeat(8);
const options = { port: 47821, token: TOKEN, platform: 'win32' };
const details = (settings) => ({ ...hooksDetails(settings, options), error: null });
const nothing = { upgrade: false, renewToken: false, notice: null };

// What version 0.1.0 installed.
function oldHttpHooks(port = 47821) {
  const hooks = {};
  for (const { event, matcher } of HOOK_EVENTS) {
    hooks[event] = [{ ...(matcher ? { matcher } : {}), hooks: [{ type: 'http', url: `http://127.0.0.1:${port}/claude-pet/hook/${event}`, timeout: 5 }] }];
  }
  return { hooks };
}

test('with the port, outdated hooks are brought up to date and anything else is left alone', () => {
  for (const settings of [oldHttpHooks(), oldHttpHooks(50000), addPetHooks({}, { ...options, port: 50000 })]) {
    assert.deepEqual(startupHooksPlan({ ok: true, hooks: details(settings), tokenSaved: true }), { ...nothing, upgrade: true });
  }
  assert.deepEqual(startupHooksPlan({ ok: true, hooks: details(addPetHooks({}, options)), tokenSaved: true }), nothing);
  assert.deepEqual(startupHooksPlan({ ok: true, hooks: details({}), tokenSaved: true }), nothing);
  assert.deepEqual(startupHooksPlan({ ok: true, hooks: { state: 'unreadable' }, tokenSaved: true }), nothing);
});

test('a token that is not the saved one is never written into Claude Code settings', () => {
  const hooks = details(addPetHooks({}, { ...options, token: 'z'.repeat(40) }));
  assert.deepEqual(startupHooksPlan({ ok: true, hooks, tokenSaved: false }), { ...nothing, notice: 'tokenProblem' });
  assert.equal(startupHooksPlan({ ok: false, hooks: details(oldHttpHooks()), tokenSaved: false }).upgrade, false);
  assert.equal(hooksAction({ state: 'missing', listening: true, tokenSaved: false }), 'tokenProblem');
});

test('when another program holds the port, hooks are never moved there', () => {
  for (const settings of [oldHttpHooks(50000), addPetHooks({}, { ...options, port: 50000 })]) {
    assert.deepEqual(startupHooksPlan({ ok: false, hooks: details(settings), tokenSaved: true }), { ...nothing, notice: 'portProblem' });
  }
  assert.deepEqual(startupHooksPlan({ ok: false, hooks: details({}), tokenSaved: true }), nothing);
});

test('on a taken port, old HTTP hooks already sending there are made async, and a token sent there is replaced', () => {
  assert.deepEqual(
    startupHooksPlan({ ok: false, hooks: details(oldHttpHooks()), tokenSaved: true }),
    { upgrade: true, renewToken: true, notice: 'portProblem' },
  );
  assert.deepEqual(
    startupHooksPlan({ ok: false, hooks: details(addPetHooks({}, options)), tokenSaved: true }),
    { upgrade: false, renewToken: true, notice: 'portProblem' },
  );
  // already async with an older token: nothing new was handed over
  assert.deepEqual(
    startupHooksPlan({ ok: false, hooks: details(addPetHooks({}, { ...options, token: 'z'.repeat(40) })), tokenSaved: true }),
    { ...nothing, notice: 'portProblem' },
  );
});

test('a taken port, then another launch with it still taken, then a launch that gets it', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pet-plan-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, JSON.stringify(oldHttpHooks()));
  const launch = (ok, token) => {
    const hooks = readHooksState({ ...options, token, file });
    const plan = startupHooksPlan({ ok, hooks, tokenSaved: true });
    const before = fs.readFileSync(file, 'utf8');
    if (plan.upgrade) upgradeHooks({ ...options, token, file });
    return { plan, rewritten: fs.readFileSync(file, 'utf8') !== before };
  };
  const first = TOKEN;
  const renewed = 'q1'.repeat(20);

  assert.deepEqual(launch(false, first), { plan: { upgrade: true, renewToken: true, notice: 'portProblem' }, rewritten: true });
  assert.equal(readHooksState({ ...options, file }).replyUsed, false);
  assert.deepEqual(launch(false, renewed), { plan: { ...nothing, notice: 'portProblem' }, rewritten: false });
  assert.deepEqual(launch(true, renewed), { plan: { ...nothing, upgrade: true }, rewritten: true });
  assert.equal(readHooksState({ ...options, token: renewed, file }).state, 'current');
  assert.equal(readHooksState({ ...options, token: first, file }).sendsToken, false);
});

test('Connect only installs while listening; Disconnect always works; unreadable settings are explained', () => {
  assert.equal(hooksAction({ state: 'missing', listening: false, tokenSaved: true }), 'portProblem');
  assert.equal(hooksAction({ state: 'missing', listening: true, tokenSaved: true }), 'install');
  for (const state of ['current', 'outdated']) {
    assert.equal(hooksAction({ state, listening: false, tokenSaved: false }), 'remove');
  }
  assert.equal(hooksAction({ state: 'unreadable', listening: true, tokenSaved: true }), 'unreadable');
});

test('the menu keeps Connect enabled when settings are unreadable and names a failed port', () => {
  assert.deepEqual(hooksMenu({ state: 'unreadable', listenerState: 'listening', port: 47821 }), {
    problem: null,
    toggle: { label: 'Connect to Claude Code…', enabled: true },
  });
  assert.equal(hooksMenu({ state: 'outdated', listenerState: 'listening', port: 47821 }).toggle.label, 'Disconnect from Claude Code…');
  const failed = hooksMenu({ state: 'missing', listenerState: 'failed', port: 50000 });
  assert.deepEqual(failed.problem, { label: "Claude Code events can't reach the pet (port 50000 is unavailable)", enabled: false });
});

test('the port notice says who gets the events and how to stop it when hooks are installed', () => {
  const installed = portProblem({ port: 47821, error: 'EADDRINUSE', installed: true });
  assert.match(installed.message, /port 47821: another program is using it/);
  assert.match(installed.detail, /Disconnect from Claude Code/);
  const notInstalled = portProblem({ port: 47821, error: 'EACCES', installed: false });
  assert.match(notInstalled.message, /can't be used \(EACCES\)/);
  assert.match(notInstalled.detail, /connect again/);
});
