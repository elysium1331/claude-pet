// Adds/removes Claude Pet's hooks in Claude Code's user settings, leaving everything else untouched.
const fs = require('node:fs');
const path = require('node:path');
const { claudeConfigDir } = require('./claude-dir');
const { readJsonFile, writeJsonAtomic } = require('./json-file');
const { TOKEN_HEADER, isValidToken } = require('./hooks-token');

const MARKER = '/claude-pet/hook/';
const BACKUP_SUFFIX = '.claude-pet-backup';
// Earlier versions left a timestamped backup on every connect and disconnect.
const OLD_BACKUP_STAMP = /^-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;

// Events the pet listens to. Tool events match every tool. Notification: permission prompts, and idle prompts,
// which are the only sign that a turn ended after Esc or a denied permission (Stop isn't sent then).
const HOOK_EVENTS = [
  { event: 'UserPromptSubmit' },
  { event: 'PreToolUse', matcher: '*' },
  { event: 'PostToolUse', matcher: '*' },
  { event: 'PostToolUseFailure', matcher: '*' },
  { event: 'PermissionRequest', matcher: '*' },
  { event: 'Notification', matcher: 'permission_prompt|idle_prompt' },
  { event: 'Stop' },
  { event: 'SessionEnd' },
];

function settingsPath() {
  return path.join(claudeConfigDir(), 'settings.json');
}

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

// The pet's hooks in either form: command hooks, or the HTTP hooks that older versions installed.
function isPetHook(hook) {
  return [hook?.url, hook?.command].some((value) => typeof value === 'string' && value.includes(MARKER));
}

// Claude Code pipes the event JSON to this command, doesn't wait for it (async) and ignores what it prints, so
// whatever answers on the port can't approve a tool or add to Claude's context. Every part is checked, since it is
// run by a shell.
function hookCommand(event, { port, token, platform = process.platform }) {
  if (!/^[A-Za-z]+$/.test(event)) throw new Error(`Unexpected hook event name: ${event}`);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Unexpected hooks port: ${port}`);
  if (!isValidToken(token)) throw new Error('The hooks token must be letters and digits only.');
  const discard = platform === 'win32' ? 'NUL' : '/dev/null';
  return `curl -s -m 2 -o ${discard} -H "Content-Type: application/json" -H "${TOKEN_HEADER}: ${token}" `
    + `--data-binary @- http://127.0.0.1:${port}${MARKER}${event}`;
}

function petHook(event, options) {
  return { type: 'command', command: hookCommand(event, options), async: true, timeout: 5 };
}

function removePetHooks(settings) {
  const next = structuredClone(settings);
  if (!next.hooks || typeof next.hooks !== 'object') return next;
  for (const [event, groups] of Object.entries(next.hooks)) {
    if (!Array.isArray(groups)) continue;
    const kept = groups
      .map((group) => (Array.isArray(group?.hooks) ? { ...group, hooks: group.hooks.filter((h) => !isPetHook(h)) } : group))
      .filter((group) => !Array.isArray(group?.hooks) || group.hooks.length > 0);
    if (kept.length) next.hooks[event] = kept;
    else delete next.hooks[event];
  }
  if (Object.keys(next.hooks).length === 0) delete next.hooks;
  return next;
}

// options: { port, token, platform }
function addPetHooks(settings, options) {
  const next = removePetHooks(settings);
  if (next.hooks != null && !isPlainObject(next.hooks)) {
    throw new Error('"hooks" in Claude Code settings is not an object, so the settings were left untouched.');
  }
  next.hooks = next.hooks || {};
  for (const { event, matcher } of HOOK_EVENTS) {
    if (next.hooks[event] != null && !Array.isArray(next.hooks[event])) {
      throw new Error(`"hooks.${event}" in Claude Code settings is not a list, so the settings were left untouched.`);
    }
    next.hooks[event] = next.hooks[event] || [];
    next.hooks[event].push({ ...(matcher ? { matcher } : {}), hooks: [petHook(event, options)] });
  }
  return next;
}

function petHookEntries(settings) {
  const entries = [];
  for (const [event, groups] of Object.entries(isPlainObject(settings?.hooks) ? settings.hooks : {})) {
    for (const group of Array.isArray(groups) ? groups : []) {
      for (const hook of Array.isArray(group?.hooks) ? group.hooks : []) {
        if (!isPetHook(hook)) continue;
        entries.push(JSON.stringify([event, group.matcher ?? null, hook.type, hook.command ?? hook.url, hook.async ?? null, hook.timeout ?? null]));
      }
    }
  }
  return entries.sort();
}

function hasPetHooks(settings) {
  return petHookEntries(settings).length > 0;
}

// 'missing' | 'current' | 'outdated' (HTTP hooks from an older version, another port or token, or other events).
function hooksState(settings, options) {
  const found = petHookEntries(settings);
  if (!found.length) return 'missing';
  const wanted = petHookEntries(addPetHooks({}, options));
  return found.length === wanted.length && found.every((entry, i) => entry === wanted[i]) ? 'current' : 'outdated';
}

function readSettings(file) {
  const read = readJsonFile(file); // tolerates a byte order mark, which Windows PowerShell adds
  if (read.status === 'missing') return { exists: false, settings: {} };
  if (read.status === 'unreadable') throw new Error(`${file} could not be read (${read.error}).`);
  if (read.status === 'invalid') throw new Error(`${file} is not valid JSON, so it was left untouched. Fix it and try again.`);
  if (!isPlainObject(read.value)) throw new Error(`${file} does not contain a settings object, so it was left untouched.`);
  return { exists: true, settings: read.value };
}

function removeOldBackups(file) {
  const dir = path.dirname(file);
  const prefix = `${path.basename(file)}${BACKUP_SUFFIX}`;
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(prefix) || !OLD_BACKUP_STAMP.test(name.slice(prefix.length))) continue;
    try {
      fs.rmSync(path.join(dir, name), { force: true });
    } catch {
      // a locked old backup is left for next time
    }
  }
}

// Keeps a single backup (settings.json.claude-pet-backup, the file as it was before the pet's latest change), so
// old copies of secrets kept in settings don't pile up. A symlinked or hard-linked settings.json (dotfiles) is
// written through, so the link keeps pointing at the user's own file.
function writeSettings(settings, exists, file) {
  if (!exists) {
    writeJsonAtomic(file, settings, { pretty: true });
    return { backupPath: null };
  }
  const target = fs.realpathSync(file);
  try {
    fs.accessSync(target, fs.constants.W_OK);
  } catch (err) {
    throw new Error(`${file} can't be changed (${err.code || err.message}); is it read-only? It was left untouched.`);
  }
  const backupPath = `${file}${BACKUP_SUFFIX}`;
  fs.copyFileSync(target, backupPath);
  removeOldBackups(file);
  if (fs.statSync(target).nlink > 1) fs.writeFileSync(target, `${JSON.stringify(settings, null, 2)}\n`);
  else writeJsonAtomic(target, settings, { pretty: true });
  return { backupPath };
}

// options: { port, token, platform, file }. Returns { changed, backupPath }.
function installHooks({ file = settingsPath(), ...options }) {
  const { exists, settings } = readSettings(file);
  if (hooksState(settings, options) === 'current') return { changed: false, backupPath: null };
  return { changed: true, ...writeSettings(addPetHooks(settings, options), exists, file) };
}

// Brings the pet's hooks up to date when they are installed but old; never adds hooks nobody asked for.
function upgradeHooks({ file = settingsPath(), ...options }) {
  const { exists, settings } = readSettings(file);
  if (hooksState(settings, options) !== 'outdated') return { changed: false, backupPath: null };
  return { changed: true, ...writeSettings(addPetHooks(settings, options), exists, file) };
}

function uninstallHooks({ file = settingsPath() } = {}) {
  const { exists, settings } = readSettings(file);
  if (!exists || !hasPetHooks(settings)) return { changed: false, backupPath: null };
  return { changed: true, ...writeSettings(removePetHooks(settings), exists, file) };
}

// { state: 'missing' | 'current' | 'outdated' | 'unreadable', error }
function readHooksState({ file = settingsPath(), ...options }) {
  try {
    return { state: hooksState(readSettings(file).settings, options), error: null };
  } catch (err) {
    return { state: 'unreadable', error: err.message };
  }
}

module.exports = {
  HOOK_EVENTS,
  BACKUP_SUFFIX,
  settingsPath,
  isPetHook,
  hookCommand,
  addPetHooks,
  removePetHooks,
  hasPetHooks,
  hooksState,
  installHooks,
  upgradeHooks,
  uninstallHooks,
  readHooksState,
};
