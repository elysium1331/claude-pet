// Polls the plan usage endpoint on a schedule, with backoff, renewal and a local cache.
const EventEmitter = require('node:events');
const fs = require('node:fs');
const { readOAuth, isExpired, renewAccessToken, retryAfterMs } = require('./claude-auth');
const { parseUsage } = require('./usage-parse');

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const MIN_BACKOFF_MS = 5 * 60_000;
const MAX_BACKOFF_MS = 30 * 60_000;

class UsageService extends EventEmitter {
  constructor({ credentialsPath, userAgent, cachePath, intervalMinutes, fakeUsagePath }) {
    super();
    this.credentialsPath = credentialsPath;
    this.userAgent = userAgent;
    this.cachePath = cachePath;
    this.fakeUsagePath = fakeUsagePath;
    this.intervalMs = intervalMinutes * 60_000;
    this.timer = null;
    this.backoffMs = 0;
    this.polling = false;
    this.snapshot = { usage: null, fetchedAt: null, status: 'loading', message: '' };
    this.loadCache();
  }

  loadCache() {
    try {
      const cached = JSON.parse(fs.readFileSync(this.cachePath, 'utf8'));
      this.snapshot = { usage: parseUsage(cached.raw), fetchedAt: new Date(cached.fetchedAt), status: 'stale', message: '' };
    } catch {
      // no cache yet
    }
  }

  start() {
    this.poll();
  }

  stop() {
    clearTimeout(this.timer);
    this.timer = null;
  }

  setIntervalMinutes(minutes) {
    const ms = minutes * 60_000;
    if (ms === this.intervalMs) return;
    const wasSlower = ms < this.intervalMs;
    this.intervalMs = ms;
    if (wasSlower && !this.backoffMs) this.poll(); // speeding up (e.g. Claude just opened): refresh now
    else this.schedule();
  }

  refreshNow() {
    this.backoffMs = 0;
    this.poll();
  }

  schedule() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.poll(), this.backoffMs || this.intervalMs);
  }

  update(patch) {
    this.snapshot = { ...this.snapshot, ...patch };
    this.emit('update', this.snapshot);
  }

  backOff(hintMs) {
    this.backoffMs = Math.min(MAX_BACKOFF_MS, Math.max(MIN_BACKOFF_MS, hintMs || this.backoffMs * 2));
  }

  async poll() {
    if (this.polling) return;
    this.polling = true;
    try {
      await this.pollOnce();
    } catch (err) {
      console.warn('[usage] poll failed:', err.message);
      this.update({ status: this.snapshot.usage ? 'stale' : 'error', message: 'Could not reach Claude' });
    } finally {
      this.polling = false;
      this.schedule();
    }
  }

  async pollOnce() {
    if (this.fakeUsagePath) {
      const raw = JSON.parse(fs.readFileSync(this.fakeUsagePath, 'utf8'));
      return this.update({ usage: parseUsage(raw), fetchedAt: new Date(), status: 'ok', message: 'fake data' });
    }

    let oauth = readOAuth(this.credentialsPath);
    if (!oauth) return this.needsLogin();
    if (isExpired(oauth)) {
      const renewed = await renewAccessToken(this.credentialsPath, this.userAgent);
      if (!renewed.ok) return this.renewFailed(renewed);
      oauth = readOAuth(this.credentialsPath);
    }

    let res = await this.fetchUsage(oauth.accessToken);
    if (res.status === 401) {
      const renewed = await renewAccessToken(this.credentialsPath, this.userAgent);
      if (!renewed.ok) return this.renewFailed(renewed);
      res = await this.fetchUsage(readOAuth(this.credentialsPath).accessToken);
    }

    if (res.status === 429) {
      this.backOff(retryAfterMs(res));
      return this.update({ status: 'stale', message: 'Usage check rate limited — retrying later' });
    }
    if (res.status === 401) return this.needsLogin();
    if (!res.ok) {
      this.backOff();
      return this.update({ status: this.snapshot.usage ? 'stale' : 'error', message: `Usage check failed (${res.status})` });
    }

    const raw = await res.json();
    const fetchedAt = new Date();
    this.backoffMs = 0;
    this.writeCache(raw, fetchedAt);
    this.update({ usage: parseUsage(raw), fetchedAt, status: 'ok', message: '' });
  }

  fetchUsage(accessToken) {
    return fetch(USAGE_URL, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'User-Agent': this.userAgent,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(15_000),
    });
  }

  renewFailed(result) {
    if (result.reason === 'needs-login') return this.needsLogin();
    this.backOff(result.retryAfterMs);
    this.update({ status: 'stale', message: 'Could not renew Claude login — retrying later' });
  }

  needsLogin() {
    this.backoffMs = MAX_BACKOFF_MS;
    this.update({ status: 'needs-login', message: 'Run `claude` once in a terminal to sign in' });
  }

  writeCache(raw, fetchedAt) {
    try {
      fs.writeFileSync(this.cachePath, JSON.stringify({ fetchedAt, raw }));
    } catch (err) {
      console.warn('[usage] could not write cache:', err.message);
    }
  }
}

module.exports = { UsageService };
