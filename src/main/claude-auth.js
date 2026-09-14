// Reads (and when expired, renews) the Claude Code login saved on this machine.
// Token values are only ever sent to Anthropic; they are never logged or stored elsewhere.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'; // Claude Code's public OAuth client
const TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token';
const EXPIRY_SKEW_MS = 60_000;

function defaultCredentialsPath() {
  return path.join(os.homedir(), '.claude', '.credentials.json');
}

function readOAuth(credentialsPath) {
  try {
    const oauth = JSON.parse(fs.readFileSync(credentialsPath, 'utf8')).claudeAiOauth;
    if (!oauth?.accessToken) return null;
    return oauth;
  } catch {
    return null;
  }
}

function isExpired(oauth, now = Date.now()) {
  return !oauth?.expiresAt || now > oauth.expiresAt - EXPIRY_SKEW_MS;
}

function retryAfterMs(res) {
  const s = Number(res.headers.get('retry-after'));
  return Number.isFinite(s) && s > 0 ? s * 1000 : null;
}

// Returns { ok: true } or { ok: false, reason: 'rate-limited' | 'needs-login' | 'error', retryAfterMs }.
async function renewAccessToken(credentialsPath, userAgent) {
  const oauth = readOAuth(credentialsPath);
  if (!oauth?.refreshToken) return { ok: false, reason: 'needs-login' };
  if (oauth.refreshTokenExpiresAt && Date.now() > oauth.refreshTokenExpiresAt) return { ok: false, reason: 'needs-login' };

  let res;
  try {
    res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': userAgent },
      body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: oauth.refreshToken, client_id: CLIENT_ID }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return { ok: false, reason: 'error' };
  }
  if (res.status === 429) return { ok: false, reason: 'rate-limited', retryAfterMs: retryAfterMs(res) };
  if (res.status === 400 || res.status === 401) return { ok: false, reason: 'needs-login' };
  if (!res.ok) return { ok: false, reason: 'error' };

  const data = await res.json();
  // Re-read right before writing so a concurrent Claude Code renewal isn't clobbered, then replace atomically.
  const file = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
  if (file.claudeAiOauth?.refreshToken !== oauth.refreshToken) return { ok: true }; // someone else renewed meanwhile
  file.claudeAiOauth = {
    ...file.claudeAiOauth,
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? file.claudeAiOauth.refreshToken,
    expiresAt: Date.now() + Number(data.expires_in) * 1000,
  };
  const tmp = `${credentialsPath}.claude-pet.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(file));
  fs.renameSync(tmp, credentialsPath);
  return { ok: true };
}

module.exports = { defaultCredentialsPath, readOAuth, isExpired, renewAccessToken, retryAfterMs };
