// Polls the plan usage endpoint on a schedule, with backoff, renewal and a local cache.
const EventEmitter = require('node:events');
const fs = require('node:fs');
const { ClaudeLogin, isExpired, retryAfterMs } = require('./claude-auth');
const { parseUsage, hasUsage, fillUnknownPercents } = require('./usage-parse');

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const MIN_BACKOFF_MS = 5 * 60_000;
const MAX_BACKOFF_MS = 30 * 60_000;
const MIN_INTERVAL_MS = 60_000;
// While signed out, look at the saved login this often (a local file read, no request), so signing in shows up fast.
const LOGIN_RECHECK_MS = 15_000;
// After sleep, give the network a moment to come back before checking.
const RESUME_DELAY_MS = 10_000;
const SIGN_IN_MESSAGE = 'Run `claude` once in a terminal to sign in';

// A zero, negative or non-numeric interval would poll back to back, so never check more than once a minute.
function intervalMsFor(minutes) {
  const ms = Number(minutes) * 60_000;
  return Number.isFinite(ms) ? Math.max(MIN_INTERVAL_MS, ms) : MIN_INTERVAL_MS;
}

function loginFingerprint(oauth) {
  return oauth ? [oauth.accessToken, oauth.refreshToken, oauth.expiresAt].join('\n') : '';
}

// What a failed check may log: the kind of error and its codes only. fetch's messages can quote the request headers,
// token included, and the log file is what people attach to bug reports.
function errorSummary(err) {
  const parts = [err?.name, err?.code, err?.cause?.code].filter((p) => typeof p === 'string' && p !== '');
  return parts.length ? parts.join(' ') : 'unknown error';
}

class UsageService extends EventEmitter {
  constructor({
    credentialsPath, userAgent, cachePath, intervalMinutes, fakeUsagePath, offline = false,
    fetch = globalThis.fetch, login = null, log = null,
  }) {
    super();
    this.credentialsPath = credentialsPath;
    this.userAgent = userAgent;
    this.cachePath = cachePath;
    this.fakeUsagePath = fakeUsagePath;
    this.offline = offline; // use only cached numbers; never contact Anthropic (test runs)
    this.fetchImpl = fetch;
    this.login = login || new ClaudeLogin({ credentialsPath, userAgent, fetch });
    this.log = log || ((context, err) => console.warn(`[usage] ${context}:`, err?.message || err));
    this.intervalMs = intervalMsFor(intervalMinutes);
    this.timer = null;
    this.backoffMs = 0;
    this.polling = false;
    this.lastPollAt = 0; // when a check last started that could contact Anthropic
    this.loginWait = null; // { until, fingerprint } while signed out
    this.snapshot = { usage: null, fetchedAt: null, status: 'loading', message: '' };
    this.loadCache();
  }

  // Offline test runs show saved numbers only: nothing may poll, renew or schedule.
  savedNumbersOnly() {
    return this.offline && !this.fakeUsagePath;
  }

  loadCache() {
    try {
      const cached = JSON.parse(fs.readFileSync(this.cachePath, 'utf8'));
      const usage = fillUnknownPercents(parseUsage(cached.raw), null);
      const fetchedAt = new Date(cached.fetchedAt);
      this.snapshot = { usage, fetchedAt: Number.isNaN(fetchedAt.getTime()) ? null : fetchedAt, status: 'stale', message: '' };
    } catch {
      // no cache yet
    }
  }

  start() {
    if (this.savedNumbersOnly()) {
      this.update({ message: this.offlineMessage() });
      return;
    }
    this.poll();
  }

  offlineMessage() {
    return this.snapshot.usage ? 'offline test run: saved numbers' : 'offline test run';
  }

  stop() {
    clearTimeout(this.timer);
    this.timer = null;
  }

  // Quitting: renewed tokens that couldn't be saved yet get one last try, or they would be lost with the process.
  saveLoginBeforeExit() {
    return this.login.saveBeforeExit();
  }

  // Keeps the time of the last check, so opening or closing Claude only changes when the next one is due.
  setIntervalMinutes(minutes) {
    const ms = intervalMsFor(minutes);
    if (ms === this.intervalMs) return;
    this.intervalMs = ms;
    if (!this.polling) this.schedule();
  }

  refreshNow() {
    if (this.savedNumbersOnly()) {
      this.update({ message: this.offlineMessage() });
      return;
    }
    this.backoffMs = 0;
    this.loginWait = null;
    this.poll();
  }

  // The computer woke up or was unlocked: check as soon as a check is due, once the network had a moment.
  resumed() {
    if (!this.polling) this.schedule(RESUME_DELAY_MS);
  }

  nextDelayMs(now = Date.now()) {
    if (this.loginWait) return LOGIN_RECHECK_MS;
    return Math.max(0, this.lastPollAt + (this.backoffMs || this.intervalMs) - now);
  }

  schedule(minDelayMs = 0) {
    clearTimeout(this.timer);
    this.timer = null;
    if (this.savedNumbersOnly()) return;
    this.timer = setTimeout(() => this.poll(), Math.max(minDelayMs, this.nextDelayMs()));
  }

  // A throwing listener must not turn accepted numbers into a failed check.
  update(patch) {
    this.snapshot = { ...this.snapshot, ...patch };
    try {
      this.emit('update', this.snapshot);
    } catch (err) {
      this.log('usage update listener', err);
    }
  }

  backOff(hintMs) {
    this.backoffMs = Math.min(MAX_BACKOFF_MS, Math.max(MIN_BACKOFF_MS, hintMs || this.backoffMs * 2));
  }

  async poll() {
    if (this.polling || this.savedNumbersOnly()) return;
    this.polling = true;
    try {
      await this.pollOnce();
    } catch (err) {
      this.log('usage check failed', errorSummary(err));
      this.backOff();
      this.update({ status: this.snapshot.usage ? 'stale' : 'error', message: 'Could not reach Claude' });
    } finally {
      this.polling = false;
      this.schedule();
    }
  }

  async pollOnce() {
    if (this.fakeUsagePath) {
      this.lastPollAt = Date.now();
      const raw = JSON.parse(fs.readFileSync(this.fakeUsagePath, 'utf8'));
      this.accept(raw, { message: 'fake data' });
      return;
    }

    let oauth = await this.login.current();
    if (this.stillSignedOut(oauth)) return;
    this.loginWait = null;
    this.lastPollAt = Date.now();
    if (!oauth) return this.needsLogin(null);
    if (isExpired(oauth)) {
      const renewed = await this.login.renew();
      if (!renewed.ok) return this.renewFailed(renewed, oauth);
      this.renewed(renewed);
      oauth = await this.login.current();
      if (!oauth) return this.needsLogin(null);
    }

    let res = await this.fetchUsage(oauth.accessToken);
    if (res.status === 401) {
      const renewed = await this.login.renew();
      if (!renewed.ok) return this.renewFailed(renewed, oauth);
      this.renewed(renewed);
      oauth = await this.login.current();
      if (!oauth) return this.needsLogin(null);
      res = await this.fetchUsage(oauth.accessToken);
    }

    if (res.status === 429) {
      this.backOff(retryAfterMs(res));
      return this.update({ status: 'stale', message: 'Usage check rate limited — retrying later' });
    }
    if (res.status === 401) return this.needsLogin(oauth);
    if (!res.ok) {
      this.backOff();
      return this.update({ status: this.snapshot.usage ? 'stale' : 'error', message: `Usage check failed (${res.status})` });
    }

    const raw = await res.json();
    if (!hasUsage(parseUsage(raw))) {
      // Keep the last good numbers (and cache) rather than replacing them with an empty reply.
      this.backOff();
      return this.update({ status: this.snapshot.usage ? 'stale' : 'error', message: 'Usage check returned no usage numbers' });
    }
    this.backoffMs = 0;
    this.accept(raw, { cache: true });
  }

  accept(raw, { message = '', cache = false } = {}) {
    const fetchedAt = new Date();
    const usage = fillUnknownPercents(parseUsage(raw), this.snapshot.usage, fetchedAt);
    if (cache) this.writeCache(raw, fetchedAt);
    this.update({ usage, fetchedAt, status: 'ok', message });
  }

  // Signed out and the saved login hasn't changed: wait without sending anything, up to the usual long backoff.
  stillSignedOut(oauth) {
    const wait = this.loginWait;
    return !!wait && Date.now() < wait.until && loginFingerprint(oauth) === wait.fingerprint;
  }

  fetchUsage(accessToken) {
    const fetchImpl = this.fetchImpl;
    return fetchImpl(USAGE_URL, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'User-Agent': this.userAgent,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(15_000),
    });
  }

  renewed(result) {
    if (result.saved === false) this.log('saving the renewed Claude login (will try again)', result.saveError);
  }

  renewFailed(result, oauth) {
    if (result.reason === 'needs-login') return this.needsLogin(oauth);
    if (result.reason === 'busy') {
      this.backoffMs = result.retryAfterMs; // Claude Code is renewing right now; it takes seconds
      return this.update({ status: 'stale', message: 'Waiting for Claude Code to renew its login' });
    }
    this.backOff(result.retryAfterMs);
    this.update({ status: 'stale', message: 'Could not renew Claude login — retrying later' });
  }

  needsLogin(oauth) {
    this.backoffMs = 0;
    this.loginWait = { until: Date.now() + MAX_BACKOFF_MS, fingerprint: loginFingerprint(oauth) };
    this.update({ status: 'needs-login', message: SIGN_IN_MESSAGE });
  }

  writeCache(raw, fetchedAt) {
    try {
      fs.writeFileSync(this.cachePath, JSON.stringify({ fetchedAt, raw }));
    } catch (err) {
      this.log('could not write the usage cache', err);
    }
  }
}

module.exports = {
  UsageService, intervalMsFor, errorSummary, MIN_INTERVAL_MS, LOGIN_RECHECK_MS, MAX_BACKOFF_MS, RESUME_DELAY_MS,
};
