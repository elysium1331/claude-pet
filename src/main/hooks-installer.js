// Adds/removes Claude Pet's HTTP hooks in Claude Code's user settings, leaving everything else untouched.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MARKER = '/claude-pet/hook/';

// Events the pet listens to. Tool events match every tool; Notification only permission prompts.
const HOOK_EVENTS = [
  { event: 'UserPromptSubmit' },
  { event: 'PreToolUse', matcher: '*' },
  { event: 'PostToolUse', matcher: '*' },
  { event: 'PostToolUseFailure', matcher: '*' },
  { event: 'PermissionRequest', matcher: '*' },
  { event: 'Notification', matcher: 'permission_prompt' },
  { event: 'Stop' },
  { event: 'SessionEnd' },
];

function settingsPath() {
  const dir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return path.join(dir, 'settings.json');
}

function isPetHook(hook) {
  return [hook?.url, hook?.command].some((value) => typeof value === 'string' && value.includes(MARKER));
}

function petHook(event, port) {
  return { type: 'http', url: `http://127.0.0.1:${port}${MARKER}${event}`, timeout: 5 };
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

function addPetHooks(settings, port) {
  const next = removePetHooks(settings);
  next.hooks = next.hooks || {};
  for (const { event, matcher } of HOOK_EVENTS) {
    next.hooks[event] = next.hooks[event] || [];
    next.hooks[event].push({ ...(matcher ? { matcher } : {}), hooks: [petHook(event, port)] });
  }
  return next;
}

function hasPetHooks(settings) {
  return Object.values(settings?.hooks || {})
    .flat()
    .some((group) => (group?.hooks || []).some(isPetHook));
}

function readSettings(file = settingsPath()) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { exists: false, settings: {} };
    throw err;
  }
  try {
    return { exists: true, settings: JSON.parse(text) };
  } catch {
    throw new Error(`${file} is not valid JSON, so it was left untouched. Fix it and try again.`);
  }
}

function writeSettings(settings, exists, file = settingsPath()) {
  let backupPath = null;
  if (exists) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    backupPath = `${file}.claude-pet-backup-${stamp}`;
    fs.copyFileSync(file, backupPath);
  } else {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  const tmp = `${file}.claude-pet.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`);
  fs.renameSync(tmp, file);
  return { backupPath };
}

function installHooks(port, file = settingsPath()) {
  const { exists, settings } = readSettings(file);
  return writeSettings(addPetHooks(settings, port), exists, file);
}

function uninstallHooks(file = settingsPath()) {
  const { exists, settings } = readSettings(file);
  if (!exists || !hasPetHooks(settings)) return { backupPath: null };
  return writeSettings(removePetHooks(settings), exists, file);
}

function hooksInstalled(file = settingsPath()) {
  return hasPetHooks(readSettings(file).settings);
}

module.exports = {
  HOOK_EVENTS,
  settingsPath,
  isPetHook,
  addPetHooks,
  removePetHooks,
  hasPetHooks,
  installHooks,
  uninstallHooks,
  hooksInstalled,
};
