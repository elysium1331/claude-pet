// Token renewal against temp credentials files and a fake token endpoint: no network, never the real ~/.claude.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  ClaudeLogin, tokensFromResponse, saveDecision, acquireRefreshLock, defaultCredentialsPath, MIN_RENEW_INTERVAL_MS, LOCK_STALE_MS,
} = require('../src/main/claude-auth');
const { claudeConfigDir } = require('../src/main/claude-dir');
const hooksInstaller = require('../src/main/hooks-installer');

const NOW = Date.UTC(2026, 8, 15, 12);
const RENEWED = { access_token: 'A2', refresh_token: 'R2', expires_in: 3600 };

function setup(oauth = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pet-auth-'));
  const file = path.join(dir, '.credentials.json');
  const content = {
    claudeAiOauth: {
      accessToken: 'A1', refreshToken: 'R1', expiresAt: NOW - 1000, scopes: ['user:inference'], subscriptionType: 'max', ...oauth,
    },
    mcpOAuth: { server: { token: 'keep me' } },
  };
  fs.writeFileSync(file, JSON.stringify(content));
  const readFile = () => JSON.parse(fs.readFileSync(file, 'utf8'));
  const writeOauth = (value) => fs.writeFileSync(file, JSON.stringify({ ...content, claudeAiOauth: value }));
  const cleanup = () => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(`${dir}.lock`, { recursive: true, force: true });
  };
  return { dir, file, content, readFile, writeOauth, cleanup };
}

function reply(status, body = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers(),
    json: async () => (typeof body === 'function' ? body() : body),
  };
}

// Each response may be a function, run when the request arrives (to change the file mid-request).
function fakeFetch(...responses) {
  const calls = [];
  const fetch = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    const next = responses.shift();
    return typeof next === 'function' ? next() : next;
  };
  return { fetch, calls };
}

function loginFor(s, { fetch, clock = { now: NOW }, fs: fsImpl } = {}) {
  return new ClaudeLogin({
    credentialsPath: s.file, userAgent: 'claude-pet-test', fetch, fs: fsImpl, now: () => clock.now, retryDelayMs: 0,
  });
}

test('the login and the hooks both follow CLAUDE_CONFIG_DIR', () => {
  assert.equal(claudeConfigDir({}, 'H'), path.join('H', '.claude'));
  assert.equal(claudeConfigDir({ CLAUDE_CONFIG_DIR: '' }, 'H'), path.join('H', '.claude'));
  assert.equal(claudeConfigDir({ CLAUDE_CONFIG_DIR: 'D:\\claude' }, 'H'), 'D:\\claude');

  const saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = path.join(os.tmpdir(), 'claude-pet-no-such-config-dir');
  try {
    assert.equal(defaultCredentialsPath(), path.join(process.env.CLAUDE_CONFIG_DIR, '.credentials.json'));
    assert.equal(hooksInstaller.settingsPath(), path.join(process.env.CLAUDE_CONFIG_DIR, 'settings.json'));
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved;
  }
});

test('tokensFromResponse accepts only a complete login', () => {
  assert.deepEqual(tokensFromResponse(RENEWED, NOW), { accessToken: 'A2', refreshToken: 'R2', expiresAt: NOW + 3_600_000 });
  assert.deepEqual(tokensFromResponse({ access_token: 'A2', expires_in: 60 }, NOW), { accessToken: 'A2', refreshToken: null, expiresAt: NOW + 60_000 });
  const bad = [
    null, [], 'token', {}, { error: 'invalid_request' },
    { access_token: '', expires_in: 60 }, { access_token: 5, expires_in: 60 },
    { access_token: 'A', refresh_token: '', expires_in: 60 }, { access_token: 'A', refresh_token: 7, expires_in: 60 },
    { access_token: 'A' }, { access_token: 'A', expires_at: NOW + 60_000 }, { access_token: 'A', expires_in: '3600' },
    { access_token: 'A', expires_in: 0 }, { access_token: 'A', expires_in: -5 }, { access_token: 'A', expires_in: Infinity },
    { access_token: 'A', expires_in: 1e12 },
  ];
  for (const body of bad) assert.equal(tokensFromResponse(body, NOW), null, JSON.stringify(body));
});

test('saveDecision never replaces a newer login and never brings back a signed-out one', () => {
  assert.equal(saveDecision({ refreshToken: 'R1' }, 'R1'), 'write');
  assert.equal(saveDecision({ accessToken: '', refreshToken: '', expiresAt: 0 }, 'R1'), 'write'); // blanked by Claude Code
  assert.equal(saveDecision({ refreshToken: 'R9' }, 'R1'), 'newer');
  assert.equal(saveDecision({ accessToken: 'A9' }, 'R1'), 'newer');
  assert.equal(saveDecision(undefined, 'R1'), 'signed-out');
  assert.equal(saveDecision(null, 'R1'), 'signed-out');
});

test('renew saves only the new tokens, keeps every other key and leaves no temp file or lock behind', async () => {
  const s = setup();
  const lockDir = path.join(s.dir, '.oauth_refresh.lock');
  let lockedDuringRequest = false;
  const { fetch, calls } = fakeFetch(() => {
    lockedDuringRequest = fs.existsSync(lockDir) && fs.existsSync(`${s.dir}.lock`);
    return reply(200, { ...RENEWED, scope: 'user:inference' });
  });
  const login = loginFor(s, { fetch });
  const result = await login.renew();
  assert.equal(result.ok, true);
  assert.equal(result.saved, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].body, { grant_type: 'refresh_token', refresh_token: 'R1', client_id: '9d1c250a-e61b-44d9-88ed-5944d1962f5e' });
  assert.equal(lockedDuringRequest, true);
  assert.deepEqual(s.readFile(), {
    ...s.content,
    claudeAiOauth: { ...s.content.claudeAiOauth, accessToken: 'A2', refreshToken: 'R2', expiresAt: NOW + 3_600_000 },
  });
  assert.deepEqual(fs.readdirSync(s.dir), ['.credentials.json']);
  assert.equal(fs.existsSync(`${s.dir}.lock`), false);
  if (process.platform !== 'win32') assert.equal(fs.statSync(s.file).mode & 0o777, 0o600);
  assert.equal((await login.current()).accessToken, 'A2');
  s.cleanup();
});

test('renew leaves the file untouched when the reply is not a complete login', async () => {
  const bodies = [
    {}, { error: 'server_error' }, { ...RENEWED, refresh_token: '' }, { access_token: 'A2', refresh_token: 'R2' },
    { ...RENEWED, expires_in: -1 }, () => { throw new SyntaxError('Unexpected end of JSON input'); },
  ];
  for (const body of bodies) {
    const s = setup();
    const before = fs.readFileSync(s.file, 'utf8');
    const login = loginFor(s, { fetch: fakeFetch(reply(200, body)).fetch });
    assert.deepEqual(await login.renew(), { ok: false, reason: 'error' });
    assert.equal(fs.readFileSync(s.file, 'utf8'), before);
    assert.deepEqual(fs.readdirSync(s.dir), ['.credentials.json']);
    assert.equal((await login.current()).accessToken, 'A1');
    s.cleanup();
  }
});

test('renewed tokens that cannot be saved are kept in memory, used, and saved on a later check', async () => {
  const s = setup();
  let renameFails = true;
  const flakyFs = {
    ...fs,
    renameSync: (from, to) => {
      if (!renameFails) return fs.renameSync(from, to);
      const err = new Error('EPERM: operation not permitted, rename');
      err.code = 'EPERM';
      throw err;
    },
  };
  const clock = { now: NOW };
  const { fetch, calls } = fakeFetch(
    reply(200, RENEWED),
    () => {
      renameFails = false;
      return reply(200, { access_token: 'A3', refresh_token: 'R3', expires_in: 3600 });
    },
  );
  const login = loginFor(s, { fetch, clock, fs: flakyFs });
  const before = fs.readFileSync(s.file, 'utf8');

  const first = await login.renew();
  assert.equal(first.ok, true);
  assert.equal(first.saved, false);
  assert.equal(first.saveError.code, 'EPERM');
  assert.equal(fs.readFileSync(s.file, 'utf8'), before);
  assert.deepEqual(fs.readdirSync(s.dir), ['.credentials.json']); // temp file removed
  assert.equal((await login.current()).refreshToken, 'R2'); // still unsaved, but used

  // Renewing again from the unsaved tokens still saves over the login the chain started from.
  clock.now += MIN_RENEW_INTERVAL_MS;
  const second = await login.renew();
  assert.equal(calls[1].body.refresh_token, 'R2');
  assert.equal(second.saved, true);
  assert.equal(s.readFile().claudeAiOauth.refreshToken, 'R3');
  assert.equal(s.readFile().mcpOAuth.server.token, 'keep me');
  assert.equal(calls.length, 2);
  s.cleanup();
});

test('an unsaved renewal is saved as soon as the file can be written again', async () => {
  const s = setup();
  let renameFails = true;
  const flakyFs = {
    ...fs,
    renameSync: (from, to) => {
      if (!renameFails) return fs.renameSync(from, to);
      throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
    },
  };
  const { fetch, calls } = fakeFetch(reply(200, RENEWED));
  const login = loginFor(s, { fetch, fs: flakyFs });
  assert.equal((await login.renew()).saved, false);
  renameFails = false;
  assert.equal((await login.current()).accessToken, 'A2');
  assert.equal(s.readFile().claudeAiOauth.refreshToken, 'R2');
  assert.equal(login.unsaved, null);
  assert.equal(calls.length, 1);
  s.cleanup();
});

test('renew keeps a login Claude Code renewed meanwhile, replaces one it blanked, and never undoes a sign-out', async () => {
  const newer = { accessToken: 'A9', refreshToken: 'R9', expiresAt: NOW + 3_600_000 };
  const cases = [
    { change: (s) => s.writeOauth(newer), expect: (s) => assert.deepEqual(s.readFile().claudeAiOauth, newer), current: 'A9' },
    {
      change: (s) => s.writeOauth({ ...s.content.claudeAiOauth, accessToken: '', refreshToken: '', expiresAt: 0 }),
      expect: (s) => assert.equal(s.readFile().claudeAiOauth.refreshToken, 'R2'),
      current: 'A2',
    },
    {
      change: (s) => fs.writeFileSync(s.file, JSON.stringify({ mcpOAuth: s.content.mcpOAuth })),
      expect: (s) => assert.equal(s.readFile().claudeAiOauth, undefined),
      current: null,
    },
    { change: (s) => fs.rmSync(s.file), expect: (s) => assert.equal(fs.existsSync(s.file), false), current: null },
  ];
  for (const c of cases) {
    const s = setup();
    const login = loginFor(s, {
      fetch: fakeFetch(() => {
        c.change(s);
        return reply(200, RENEWED);
      }).fetch,
    });
    assert.equal((await login.renew()).ok, true);
    c.expect(s);
    assert.equal((await login.current())?.accessToken ?? null, c.current);
    s.cleanup();
  }
});

test('a turned-down refresh token counts as renewed if Claude Code saved a newer login, otherwise it is never sent again', async () => {
  const s = setup();
  const newer = { accessToken: 'A9', refreshToken: 'R9', expiresAt: NOW + 3_600_000 };
  const clock = { now: NOW };
  const raced = loginFor(s, {
    clock,
    fetch: fakeFetch(() => {
      s.writeOauth(newer);
      return reply(400, { error: 'invalid_grant' });
    }).fetch,
  });
  assert.deepEqual(await raced.renew(), { ok: true, saved: true });
  assert.equal((await raced.current()).accessToken, 'A9');

  s.writeOauth(s.content.claudeAiOauth);
  const { fetch, calls } = fakeFetch(reply(400, { error: 'invalid_grant' }), reply(200, RENEWED));
  const dead = loginFor(s, { clock, fetch });
  assert.deepEqual(await dead.renew(), { ok: false, reason: 'needs-login' });
  clock.now += 2 * MIN_RENEW_INTERVAL_MS;
  assert.deepEqual(await dead.renew(), { ok: false, reason: 'needs-login' });
  assert.equal(calls.length, 1);

  // Signing in again (a new refresh token) is renewed normally.
  s.writeOauth({ ...s.content.claudeAiOauth, refreshToken: 'R5' });
  assert.equal((await dead.renew()).ok, true);
  assert.equal(calls[1].body.refresh_token, 'R5');
  s.cleanup();
});

test('renew does not skip Claude Code: it looks at the file again once it holds the lock', async () => {
  const s = setup();
  const { fetch, calls } = fakeFetch(reply(200, RENEWED));
  const login = loginFor(s, { fetch });
  const readsBefore = login.current.bind(login);
  let first = true;
  login.current = async () => {
    const value = await readsBefore();
    if (first) {
      first = false;
      s.writeOauth({ accessToken: 'A9', refreshToken: 'R9', expiresAt: NOW + 3_600_000 }); // renewed just before the lock
    }
    return value;
  };
  assert.deepEqual(await login.renew(), { ok: true, saved: true });
  assert.equal(calls.length, 0);
  assert.equal(s.readFile().claudeAiOauth.refreshToken, 'R9');
  s.cleanup();
});

test('renewal waits at least five minutes between token exchanges', async () => {
  const s = setup();
  const clock = { now: NOW };
  const { fetch, calls } = fakeFetch(reply(500), reply(200, RENEWED));
  const login = loginFor(s, { fetch, clock });
  assert.deepEqual(await login.renew(), { ok: false, reason: 'error' });
  clock.now += 60_000;
  assert.deepEqual(await login.renew(), { ok: false, reason: 'too-soon', retryAfterMs: MIN_RENEW_INTERVAL_MS - 60_000 });
  assert.equal(calls.length, 1);
  clock.now = NOW + MIN_RENEW_INTERVAL_MS;
  assert.equal((await login.renew()).ok, true);
  assert.equal(calls.length, 2);
  s.cleanup();
});

test('renew waits while Claude Code holds its refresh lock, takes over an abandoned one, and always releases its own', async () => {
  const s = setup();
  const lockDir = path.join(s.dir, '.oauth_refresh.lock');
  const legacyDir = `${s.dir}.lock`;
  const { fetch, calls } = fakeFetch(() => { throw new Error('offline'); }, reply(200, RENEWED));
  const clock = { now: NOW };
  const login = loginFor(s, { fetch, clock });

  fs.mkdirSync(lockDir);
  assert.deepEqual(await login.renew(), { ok: false, reason: 'busy', retryAfterMs: 20_000 });
  assert.equal(fs.existsSync(lockDir), true); // Claude Code's lock is left alone
  assert.equal(fs.existsSync(legacyDir), false);
  fs.rmdirSync(lockDir);

  fs.mkdirSync(legacyDir);
  assert.equal((await login.renew()).reason, 'busy');
  assert.equal(fs.existsSync(lockDir), false); // the half-taken lock was given back
  fs.rmdirSync(legacyDir);
  assert.equal(calls.length, 0);

  // A request that throws still releases the lock.
  assert.deepEqual(await login.renew(), { ok: false, reason: 'error' });
  assert.equal(fs.existsSync(lockDir), false);
  assert.equal(fs.existsSync(legacyDir), false);

  // A lock nobody has touched for a minute was abandoned.
  clock.now += MIN_RENEW_INTERVAL_MS;
  fs.mkdirSync(lockDir);
  const old = new Date(Date.now() - LOCK_STALE_MS - 5000);
  fs.utimesSync(lockDir, old, old);
  assert.equal((await login.renew()).ok, true);
  assert.equal(fs.existsSync(lockDir), false);
  assert.equal(calls.length, 2);
  s.cleanup();
});

test('acquireRefreshLock reports a folder it cannot lock in as failed and leaves nothing behind', () => {
  const s = setup();
  const lock = acquireRefreshLock(path.join(s.dir, 'missing'));
  assert.equal(lock.status, 'failed');
  lock.release();
  const taken = acquireRefreshLock(s.dir);
  assert.equal(taken.status, 'taken');
  assert.equal(acquireRefreshLock(s.dir).status, 'held');
  taken.release();
  assert.deepEqual(fs.readdirSync(s.dir), ['.credentials.json']);
  s.cleanup();
});
