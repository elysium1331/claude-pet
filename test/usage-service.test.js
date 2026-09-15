// UsageService with a fake login and a fake fetch: no network, no credentials files.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { UsageService, LOGIN_RECHECK_MS } = require('../src/main/usage-service');
const sample = require('./fixtures/usage-response.json');

const GOOD = { accessToken: 'A1', refreshToken: 'R1', expiresAt: Date.now() + 3_600_000 };
const EXPIRED = { ...GOOD, expiresAt: 1 };

function tempCache() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pet-usage-')), 'usage-cache.json');
}

function fakeLogin(loginOrFn, renewResults = []) {
  const login = {
    currentCalls: 0,
    renewCalls: 0,
    current: async () => {
      login.currentCalls += 1;
      return typeof loginOrFn === 'function' ? loginOrFn() : loginOrFn;
    },
    renew: async () => {
      login.renewCalls += 1;
      return renewResults.shift() ?? { ok: true, saved: true };
    },
  };
  return login;
}

function usageReply(body, status = 200) {
  return { status, ok: status >= 200 && status < 300, headers: new Headers(), json: async () => body };
}

function withPercent(kind, percent) {
  return { ...sample, limits: sample.limits.map((l) => (l.kind === kind ? { ...l, percent } : l)) };
}

// Timers are stubbed so tests never wait or leave anything running.
function service(options) {
  const s = new UsageService({ cachePath: tempCache(), intervalMinutes: 2, userAgent: 'claude-pet-test', ...options });
  s.schedule = () => {};
  return s;
}

test('offline test runs never read the login, renew or fetch, whatever asks for a check', async () => {
  let fetches = 0;
  const login = fakeLogin(GOOD);
  const s = new UsageService({
    cachePath: tempCache(), intervalMinutes: 10, offline: true, login, fetch: async () => { fetches += 1; },
  });
  s.start();
  s.setIntervalMinutes(2); // Claude opened
  s.refreshNow();
  s.resumed();
  await s.poll();
  assert.equal(fetches, 0);
  assert.equal(login.currentCalls, 0);
  assert.equal(login.renewCalls, 0);
  assert.equal(s.timer, null);
  assert.equal(s.snapshot.message, 'offline test run');
});

test('a throwing update listener does not turn accepted numbers into a failed check', async () => {
  const logged = [];
  const s = service({ login: fakeLogin(GOOD), fetch: async () => usageReply(sample), log: (context) => logged.push(context) });
  s.on('update', () => { throw new TypeError('view broke'); });
  await s.poll();
  assert.equal(s.snapshot.status, 'ok');
  assert.equal(s.snapshot.message, '');
  assert.equal(s.backoffMs, 0);
  assert.deepEqual(logged, ['usage update listener']);
});

test('a reply without usage numbers keeps the last good numbers and cache, and backs off', async () => {
  const cachePath = tempCache();
  const replies = [usageReply(sample), usageReply({}), usageReply({ error: { type: 'overloaded' } })];
  const s = service({ cachePath, login: fakeLogin(GOOD), fetch: async () => replies.shift() });
  await s.poll();
  const good = s.snapshot.usage;
  const cached = fs.readFileSync(cachePath, 'utf8');
  for (let i = 0; i < 2; i += 1) {
    await s.poll();
    assert.equal(s.snapshot.usage, good);
    assert.equal(s.snapshot.status, 'stale');
    assert.match(s.snapshot.message, /no usage numbers/);
    assert.equal(fs.readFileSync(cachePath, 'utf8'), cached);
  }
  assert.ok(s.backoffMs >= 5 * 60_000);
});

test('a meter sent without a percent keeps its last value instead of reading 0%', async () => {
  const replies = [usageReply(withPercent('session', null)), usageReply(sample), usageReply(withPercent('session', null))];
  const s = service({ login: fakeLogin(GOOD), fetch: async () => replies.shift() });
  await s.poll();
  assert.equal(s.snapshot.usage.session, null); // never seen with a number: left out
  await s.poll();
  assert.equal(s.snapshot.usage.session.percent, 7);
  await s.poll();
  assert.equal(s.snapshot.status, 'ok');
  assert.equal(s.snapshot.usage.session.percent, 7);
});

test('a login that disappears during renewal shows the sign-in prompt, not a network error', async () => {
  let reads = 0;
  const expiredThenGone = fakeLogin(() => (reads++ === 0 ? EXPIRED : null));
  const s = service({ login: expiredThenGone, fetch: async () => { throw new Error('must not fetch'); } });
  await s.poll();
  assert.equal(s.snapshot.status, 'needs-login');
  assert.equal(s.snapshot.message, 'Run `claude` once in a terminal to sign in');

  reads = 0;
  const rejectedThenGone = fakeLogin(() => (reads++ === 0 ? GOOD : null));
  const t = service({ login: rejectedThenGone, fetch: async () => usageReply({}, 401) });
  await t.poll();
  assert.equal(rejectedThenGone.renewCalls, 1);
  assert.equal(t.snapshot.status, 'needs-login');
});

test('while signed out it looks for a new login every few seconds without sending anything', async () => {
  let saved = null;
  let fetches = 0;
  const login = fakeLogin(() => saved);
  const s = service({ login, fetch: async () => { fetches += 1; return usageReply(sample); } });
  await s.poll();
  assert.equal(s.snapshot.status, 'needs-login');
  assert.equal(s.nextDelayMs(), LOGIN_RECHECK_MS);
  s.setIntervalMinutes(10); // Claude opening or closing doesn't push the recheck out
  assert.equal(s.nextDelayMs(), LOGIN_RECHECK_MS);
  await s.poll();
  assert.equal(fetches, 0);

  saved = GOOD; // the user ran `claude` and signed in
  await s.poll();
  assert.equal(fetches, 1);
  assert.equal(s.snapshot.status, 'ok');
  assert.equal(s.nextDelayMs(s.lastPollAt + 1000), 599_000);
});

test('a turned-down login is not tried again until it changes or the long wait is over', async () => {
  const login = fakeLogin(EXPIRED, [{ ok: false, reason: 'needs-login' }, { ok: false, reason: 'needs-login' }]);
  const s = service({ login, fetch: async () => { throw new Error('must not fetch'); } });
  await s.poll();
  await s.poll();
  assert.equal(login.renewCalls, 1);
  s.loginWait.until = Date.now() - 1;
  await s.poll();
  assert.equal(login.renewCalls, 2);
  assert.equal(s.snapshot.status, 'needs-login');
});

test('opening Claude checks right away only when a check is due at the faster pace; backoff keeps its deadline', () => {
  const s = service({ login: fakeLogin(GOOD), intervalMinutes: 10 });
  let polls = 0;
  s.poll = async () => { polls += 1; };
  const now = 1_000_000_000;
  s.lastPollAt = now - 30_000;
  s.setIntervalMinutes(2);
  assert.equal(s.nextDelayMs(now), 90_000);
  s.lastPollAt = now - 5 * 60_000;
  assert.equal(s.nextDelayMs(now), 0);
  s.backoffMs = 5 * 60_000;
  s.lastPollAt = now - 60_000;
  s.setIntervalMinutes(10);
  assert.equal(s.nextDelayMs(now), 4 * 60_000);
  assert.equal(polls, 0); // only the timer polls
});

test('a failed check backs off, and Claude Code renewing right now is retried soon', async () => {
  const s = service({ login: fakeLogin(GOOD), fetch: async () => { throw new Error('ECONNRESET'); }, log: () => {} });
  await s.poll();
  assert.equal(s.snapshot.status, 'error');
  assert.equal(s.snapshot.message, 'Could not reach Claude');
  assert.equal(s.backoffMs, 5 * 60_000);

  const busy = service({ login: fakeLogin(EXPIRED, [{ ok: false, reason: 'busy', retryAfterMs: 20_000 }]) });
  await busy.poll();
  assert.equal(busy.snapshot.status, 'stale');
  assert.ok(busy.nextDelayMs() <= 20_000 && busy.nextDelayMs() > 15_000);
});
