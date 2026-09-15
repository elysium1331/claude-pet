// Reads (and when expired, renews) the Claude Code login saved on this machine.
// Token values are only ever sent to Anthropic; they are never logged or stored elsewhere.
const nodeFs = require('node:fs');
const path = require('node:path');
const { claudeConfigDir } = require('./claude-dir');
const { readJsonFile } = require('./json-file');

const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'; // Claude Code's public OAuth client
const TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token';
const EXPIRY_SKEW_MS = 60_000;
const RENEW_TIMEOUT_MS = 10_000;
const MAX_EXPIRES_IN_S = 30 * 24 * 60 * 60;
// Each renewal can rotate the refresh token, so never exchange it more often than this, whatever the file says.
const MIN_RENEW_INTERVAL_MS = 5 * 60_000;
const BUSY_RETRY_MS = 20_000;

// Claude Code 2.1.x renews under proper-lockfile locks: folders made with mkdir at <login folder>/.oauth_refresh.lock
// and <login folder>.lock, touched every 5 s and treated as abandoned after 60 s. Taking the same folders keeps the
// pet and Claude Code from exchanging one refresh token at the same time, which can sign both out.
const LOCK_STALE_MS = 60_000;
const LOCK_UPDATE_MS = 5_000;

// Windows refuses to replace a file another program (antivirus, backup, indexer) has open.
const RENAME_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RENAME_ATTEMPTS = 4;
// Until renewed tokens are saved, the file holds a refresh token the server may already have retired, and a Claude
// Code started meanwhile would be signed out by it. So a failed save is retried within seconds, on its own timer.
const SAVE_RETRY_MS = 5_000;
const SAVE_RETRY_MAX_MS = 60_000;

function defaultCredentialsPath() {
  return path.join(claudeConfigDir(), '.credentials.json');
}

const nonEmptyString = (v) => typeof v === 'string' && v !== '';
const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
// Tokens are visible ASCII. Anything else is refused: fetch quotes an invalid header value, token and all, in its error.
const isToken = (v) => typeof v === 'string' && /^[\x21-\x7e]+$/.test(v);

function readOAuth(credentialsPath) {
  const read = readJsonFile(credentialsPath);
  const oauth = read.status === 'ok' ? read.value?.claudeAiOauth : null;
  if (!isToken(oauth?.accessToken)) return null;
  // A blank refresh token is one Claude Code cleared after the server turned it down.
  return oauth.refreshToken == null || oauth.refreshToken === '' || isToken(oauth.refreshToken) ? oauth : null;
}

function isExpired(oauth, now = Date.now()) {
  return !oauth?.expiresAt || now > oauth.expiresAt - EXPIRY_SKEW_MS;
}

function retryAfterMs(res) {
  const s = Number(res.headers.get('retry-after'));
  return Number.isFinite(s) && s > 0 ? s * 1000 : null;
}

// The tokens from a token endpoint reply, or null when the reply isn't a usable login. Nothing else is ever saved.
function tokensFromResponse(data, now = Date.now()) {
  if (!isPlainObject(data)) return null;
  const { access_token: accessToken, refresh_token: refreshToken, expires_in: expiresIn } = data;
  if (!isToken(accessToken)) return null;
  if (refreshToken != null && !isToken(refreshToken)) return null;
  if (typeof expiresIn !== 'number' || !Number.isFinite(expiresIn) || expiresIn <= 0 || expiresIn > MAX_EXPIRES_IN_S) return null;
  return { accessToken, refreshToken: refreshToken ?? null, expiresAt: now + Math.round(expiresIn * 1000) };
}

// Whether a 400/401 reply from the token endpoint means the refresh token itself is dead. Like Claude Code, only
// invalid_grant counts, and not when it says the account is on hold: invalid_scope, invalid_client and the like say
// nothing about the token, so it may be tried again later.
function refreshTokenDead(body) {
  if (!isPlainObject(body)) return false;
  const code = typeof body.error === 'string' ? body.error : body.error?.type;
  return code === 'invalid_grant' && body.error_description !== 'account_on_hold';
}

// Whether renewed tokens (from a chain that started at refresh token `basedOn`) may replace the login on disk:
// 'write', 'newer' (someone renewed or signed in since: keep theirs) or 'signed-out' (don't bring the login back).
function saveDecision(onDiskOauth, basedOn) {
  if (!isPlainObject(onDiskOauth)) return 'signed-out';
  if (onDiskOauth.refreshToken === basedOn) return 'write';
  // Claude Code blanks a refresh token the server turned down; the pet's renewed login is the live one then.
  if (onDiskOauth.refreshToken === '') return 'write';
  return 'newer';
}

// 'taken' | 'held' | 'failed'
function takeLockDir(fs, lockPath) {
  try {
    fs.mkdirSync(lockPath);
    return 'taken';
  } catch (err) {
    if (err.code !== 'EEXIST') return 'failed';
  }
  try {
    if (Date.now() - fs.statSync(lockPath).mtimeMs < LOCK_STALE_MS) return 'held';
    fs.rmdirSync(lockPath); // abandoned, as proper-lockfile would treat it
    fs.mkdirSync(lockPath);
    return 'taken';
  } catch {
    return 'held';
  }
}

function refreshLockPaths(dir, fs) {
  let real = dir;
  try {
    real = fs.realpathSync(dir);
  } catch {
    // keep the path as given
  }
  return [path.join(dir, '.oauth_refresh.lock'), `${real}.lock`];
}

// { status: 'taken' | 'held' | 'failed', release }. Unless both locks were taken, nothing is left behind.
// 'failed' means the lock folders can't be made at all (Claude Code couldn't lock there either).
function acquireRefreshLock(dir, fs = nodeFs) {
  const taken = [];
  let timer = null;
  const release = () => {
    clearInterval(timer);
    for (const lockPath of taken.splice(0).reverse()) {
      try {
        fs.rmdirSync(lockPath);
      } catch {
        // already gone
      }
    }
  };
  for (const lockPath of refreshLockPaths(dir, fs)) {
    const status = takeLockDir(fs, lockPath);
    if (status !== 'taken') {
      release();
      return { status, release };
    }
    taken.push(lockPath);
  }
  timer = setInterval(() => {
    const t = new Date();
    for (const lockPath of taken) {
      try {
        fs.utimesSync(lockPath, t, t);
      } catch {
        // Claude Code will treat it as abandoned; nothing else to do
      }
    }
  }, LOCK_UPDATE_MS);
  timer.unref?.();
  return { status: 'taken', release };
}

const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// The login Claude Code saved in .credentials.json, renewed when needed. Renewed tokens that can't be saved yet
// (file locked by antivirus, say) are kept in memory and used, and saving them is retried every few seconds.
class ClaudeLogin {
  constructor({
    credentialsPath, userAgent, fetch = globalThis.fetch, fs = nodeFs, now = Date.now, retryDelayMs = 100,
    saveRetryMs = SAVE_RETRY_MS,
  }) {
    this.credentialsPath = credentialsPath;
    this.userAgent = userAgent;
    this.fetchImpl = fetch;
    this.fs = fs;
    this.now = now;
    this.retryDelayMs = retryDelayMs;
    this.saveRetryMs = saveRetryMs;
    this.saveTimer = null;
    this.saveRetryDelayMs = 0; // wait before the latest save retry; 0 once nothing is left unsaved
    this.unsaved = null; // { basedOn, oauth }
    this.lastRenewAt = 0;
    this.rejected = new Set(); // refresh tokens the server said are dead: never sent again
    this.lastSaveError = null;
  }

  // The login to use now: renewed tokens still waiting to be saved, or what the file holds. null = signed out.
  async current() {
    if (this.unsaved) await this.saveUnsaved();
    return this.unsaved?.oauth ?? readOAuth(this.credentialsPath);
  }

  // Returns true when nothing is left unsaved. A file another program has open is retried a few times at once; if it
  // still can't be saved, a timer keeps trying, a little less often each time.
  async saveUnsaved({ locked = false } = {}) {
    let saved = this.saveNow({ locked });
    for (let attempt = 1; !saved && attempt < RENAME_ATTEMPTS && RENAME_RETRY_CODES.has(this.lastSaveError?.code); attempt += 1) {
      await delay(this.retryDelayMs * attempt);
      saved = this.saveNow({ locked });
    }
    if (saved) this.stopSaving();
    else this.keepSaving();
    return saved;
  }

  // One save attempt. Synchronous, so it can also run while the app quits. Returns true when nothing is left unsaved.
  saveNow({ locked = false } = {}) {
    if (!this.unsaved) return true;
    this.lastSaveError = null;
    const lock = locked ? null : acquireRefreshLock(path.dirname(this.credentialsPath), this.fs);
    if (lock?.status === 'held') return false;
    try {
      const read = readJsonFile(this.credentialsPath);
      if (read.status === 'unreadable' || read.status === 'invalid' || (read.status === 'ok' && !isPlainObject(read.value))) {
        return false; // Claude Code may be writing it right now: try again shortly
      }
      const file = read.status === 'ok' ? read.value : null;
      if (saveDecision(file?.claudeAiOauth, this.unsaved.basedOn) !== 'write') {
        this.unsaved = null;
        return true;
      }
      this.writeCredentials({ ...file, claudeAiOauth: { ...file.claudeAiOauth, ...this.unsaved.oauth } });
      this.unsaved = null;
      return true;
    } catch (err) {
      this.lastSaveError = err;
      return false;
    } finally {
      lock?.release();
    }
  }

  keepSaving() {
    if (this.saveTimer || !this.unsaved) return;
    this.saveRetryDelayMs = Math.min(SAVE_RETRY_MAX_MS, this.saveRetryDelayMs * 2 || this.saveRetryMs);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.saveUnsaved();
    }, this.saveRetryDelayMs);
    this.saveTimer.unref?.();
  }

  stopSaving() {
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    this.saveRetryDelayMs = 0;
  }

  // The app is quitting: one last try, finished before this returns, so renewed tokens aren't lost with the process.
  saveBeforeExit() {
    this.stopSaving();
    return this.saveNow();
  }

  // Writes a temp file only the owner can read, then renames it over the credentials file. The temp file is
  // always removed, and 'wx' refuses to write through anything already sitting at its path.
  writeCredentials(value) {
    const { fs } = this;
    const file = this.credentialsPath;
    const tmp = `${file}.claude-pet.tmp`;
    try {
      fs.rmSync(tmp, { force: true });
      fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
      fs.renameSync(tmp, file);
    } finally {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        // nothing more to do
      }
    }
  }

  // { ok: true, saved } or { ok: false, reason: 'needs-login' | 'rate-limited' | 'busy' | 'too-soon' | 'error', retryAfterMs }
  async renew() {
    const now = this.now();
    if (this.lastRenewAt && now - this.lastRenewAt < MIN_RENEW_INTERVAL_MS) {
      return { ok: false, reason: 'too-soon', retryAfterMs: this.lastRenewAt + MIN_RENEW_INTERVAL_MS - now };
    }
    const login = await this.current();
    const refreshToken = login?.refreshToken;
    if (!nonEmptyString(refreshToken) || this.rejected.has(refreshToken)) return { ok: false, reason: 'needs-login' };
    if (login.refreshTokenExpiresAt && now > login.refreshTokenExpiresAt) return { ok: false, reason: 'needs-login' };
    const basedOn = this.unsaved ? this.unsaved.basedOn : refreshToken;

    const lock = acquireRefreshLock(path.dirname(this.credentialsPath), this.fs);
    if (lock.status === 'held') return { ok: false, reason: 'busy', retryAfterMs: BUSY_RETRY_MS };
    try {
      // Like Claude Code, look again once the lock is held: it may have just renewed or signed out.
      const onDisk = readOAuth(this.credentialsPath);
      if (!this.unsaved) {
        if (!onDisk) return { ok: false, reason: 'needs-login' };
        if (onDisk.accessToken !== login.accessToken || onDisk.refreshToken !== refreshToken) return { ok: true, saved: true };
      }

      this.lastRenewAt = now;
      let res;
      try {
        const fetchImpl = this.fetchImpl;
        res = await fetchImpl(TOKEN_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'User-Agent': this.userAgent },
          body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: CLIENT_ID }),
          signal: AbortSignal.timeout(RENEW_TIMEOUT_MS),
        });
      } catch {
        return { ok: false, reason: 'error' };
      }
      if (res.status === 429) return { ok: false, reason: 'rate-limited', retryAfterMs: retryAfterMs(res) };
      if (res.status === 400 || res.status === 401) {
        let body = null;
        try {
          body = await res.json();
        } catch {
          // unreadable body
        }
        return refreshTokenDead(body) ? this.turnedDown(refreshToken, basedOn) : { ok: false, reason: 'error' };
      }
      if (!res.ok) return { ok: false, reason: 'error' };

      let tokens = null;
      try {
        tokens = tokensFromResponse(await res.json(), this.now());
      } catch {
        // unreadable body
      }
      if (!tokens) return { ok: false, reason: 'error' };
      this.unsaved = { basedOn, oauth: { ...tokens, refreshToken: tokens.refreshToken ?? refreshToken } };
      const saved = await this.saveUnsaved({ locked: true });
      return { ok: true, saved, saveError: saved ? null : this.lastSaveError };
    } finally {
      lock.release();
    }
  }

  // The server said the refresh token is dead. Claude Code may have renewed first, so check the file before giving up.
  turnedDown(refreshToken, basedOn) {
    if (this.unsaved?.oauth.refreshToken === refreshToken) {
      this.unsaved = null;
      this.stopSaving();
    }
    const onDisk = readOAuth(this.credentialsPath);
    if (nonEmptyString(onDisk?.refreshToken) && onDisk.refreshToken !== refreshToken && onDisk.refreshToken !== basedOn) {
      return { ok: true, saved: true };
    }
    this.rejected.add(refreshToken);
    this.rejected.add(basedOn); // a token the pet already exchanged is spent too
    return { ok: false, reason: 'needs-login' };
  }
}

module.exports = {
  defaultCredentialsPath,
  readOAuth,
  isExpired,
  retryAfterMs,
  tokensFromResponse,
  refreshTokenDead,
  saveDecision,
  acquireRefreshLock,
  ClaudeLogin,
  MIN_RENEW_INTERVAL_MS,
  LOCK_STALE_MS,
  SAVE_RETRY_MS,
};
