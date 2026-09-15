const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  addPetHooks, removePetHooks, hasPetHooks, isPetHook, hooksState, hooksDetails, hookCommand, installHooks, upgradeHooks,
  uninstallHooks, readHooksState, HOOK_EVENTS, BACKUP_SUFFIX,
} = require('../src/main/hooks-installer');

const TOKEN = 'abc123'.repeat(8);
const options = { port: 47821, token: TOKEN, platform: 'win32' };
const userHook = { type: 'command', command: 'echo my own hook' };
const existing = {
  model: 'opus',
  env: { SOME_KEY: 'secret' },
  hooks: {
    PreToolUse: [{ matcher: 'Bash', hooks: [userHook] }],
    Stop: [{ hooks: [userHook] }],
  },
};

// What version 0.1.0 installed.
function oldHttpHooks(settings, port = 47821) {
  const next = structuredClone(settings);
  next.hooks = next.hooks || {};
  for (const { event, matcher } of [...HOOK_EVENTS.filter((e) => e.event !== 'Notification'), { event: 'Notification', matcher: 'permission_prompt' }]) {
    next.hooks[event] = next.hooks[event] || [];
    next.hooks[event].push({
      ...(matcher ? { matcher } : {}),
      hooks: [{ type: 'http', url: `http://127.0.0.1:${port}/claude-pet/hook/${event}`, timeout: 5 }],
    });
  }
  return next;
}

function tempSettings(t, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pet-hooks-'));
  t.after(() => {
    for (const name of fs.readdirSync(dir)) fs.chmodSync(path.join(dir, name), 0o666);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const file = path.join(dir, 'settings.json');
  if (content !== undefined) fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
  return { dir, file };
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

test('pet hooks are async command hooks that pipe the event to curl and discard the reply', () => {
  const next = addPetHooks(existing, options);
  for (const { event } of HOOK_EVENTS) {
    const petHooks = next.hooks[event].flatMap((g) => g.hooks).filter(isPetHook);
    assert.equal(petHooks.length, 1, event);
    assert.deepEqual(petHooks[0], {
      type: 'command',
      command: `curl -s -m 2 --noproxy 127.0.0.1 -o NUL -H "Content-Type: application/json" -H "X-Claude-Pet-Token: ${TOKEN}" --data-binary @- http://127.0.0.1:47821/claude-pet/hook/${event}`,
      async: true,
      timeout: 5,
    });
  }
  assert.equal(next.model, 'opus');
  assert.deepEqual(next.hooks.PreToolUse[0], { matcher: 'Bash', hooks: [userHook] });
  assert.deepEqual(next.hooks.Stop[0], { hooks: [userHook] });
  assert.equal(hasPetHooks(next), true);
  assert.equal(existing.hooks.PreToolUse.length, 1); // the input object is not modified
});

test('idle prompts reach the pet, so interrupted turns can end', () => {
  const group = addPetHooks({}, options).hooks.Notification[0];
  assert.equal(group.matcher, 'permission_prompt|idle_prompt');
});

test('the command discards output to /dev/null outside Windows', () => {
  assert.match(hookCommand('Stop', { ...options, platform: 'linux' }), /^curl -s -m 2 --noproxy 127\.0\.0\.1 -o \/dev\/null -H /);
});

test('hookCommand refuses anything that is not safe inside a shell command', () => {
  for (const token of ['', 'short', `${TOKEN}"; rm -rf ~`, `${TOKEN} x`, null]) {
    assert.throws(() => hookCommand('Stop', { ...options, token }), /letters and digits/);
  }
  assert.throws(() => hookCommand('Stop; calc', options), /event/);
  assert.throws(() => hookCommand('Stop', { ...options, port: '47821 && calc' }), /port/);
});

test('addPetHooks is idempotent and can change the port', () => {
  const twice = addPetHooks(addPetHooks(existing, options), { ...options, port: 50000 });
  const petHooks = Object.values(twice.hooks).flat().flatMap((g) => g.hooks).filter(isPetHook);
  assert.equal(petHooks.length, HOOK_EVENTS.length);
  assert.ok(petHooks.every((h) => h.command.includes(':50000/')));
});

test('removePetHooks restores the original settings, from both the new and the old kind of hooks', () => {
  assert.deepEqual(removePetHooks(addPetHooks(existing, options)), existing);
  assert.deepEqual(removePetHooks(oldHttpHooks(existing)), existing);
  assert.equal(hasPetHooks(existing), false);
  assert.deepEqual(removePetHooks(addPetHooks({}, options)), {});
  assert.deepEqual(removePetHooks({ theme: 'dark' }), { theme: 'dark' });
});

test('hooksState tells missing, current and outdated hooks apart', () => {
  assert.equal(hooksState(existing, options), 'missing');
  assert.equal(hooksState(addPetHooks(existing, options), options), 'current');
  assert.equal(hooksState(oldHttpHooks(existing), options), 'outdated');
  assert.equal(hooksState(addPetHooks(existing, { ...options, port: 50000 }), options), 'outdated');
  assert.equal(hooksState(addPetHooks(existing, { ...options, token: 'z'.repeat(40) }), options), 'outdated');
  const oneMissing = addPetHooks(existing, options);
  delete oneMissing.hooks.SessionEnd;
  assert.equal(hooksState(oneMissing, options), 'outdated');
  // command hooks from before --noproxy, which a proxy setting could send off the computer
  const beforeNoProxy = addPetHooks(existing, options);
  for (const group of Object.values(beforeNoProxy.hooks).flat()) {
    for (const hook of group.hooks) if (isPetHook(hook)) hook.command = hook.command.replace(' --noproxy 127.0.0.1', '');
  }
  assert.equal(hooksState(beforeNoProxy, options), 'outdated');
});

test('hooksDetails tells where the hooks send events, with what token, and whether Claude Code reads the reply', () => {
  assert.deepEqual(hooksDetails(existing, options), { state: 'missing', samePort: false, replyUsed: false, sendsToken: false });
  assert.deepEqual(hooksDetails(addPetHooks(existing, options), options), { state: 'current', samePort: true, replyUsed: false, sendsToken: true });
  assert.deepEqual(hooksDetails(oldHttpHooks(existing), options), { state: 'outdated', samePort: true, replyUsed: true, sendsToken: false });
  assert.deepEqual(hooksDetails(oldHttpHooks(existing, 50000), options), { state: 'outdated', samePort: false, replyUsed: true, sendsToken: false });
  assert.deepEqual(
    hooksDetails(addPetHooks(existing, { ...options, port: 50000 }), options),
    { state: 'outdated', samePort: false, replyUsed: false, sendsToken: false },
  );
  assert.deepEqual(
    hooksDetails(addPetHooks(existing, { ...options, token: 'z'.repeat(40) }), options),
    { state: 'outdated', samePort: true, replyUsed: false, sendsToken: false },
  );
  const mixed = addPetHooks(oldHttpHooks({}, 50000), options);
  mixed.hooks.Stop.push({ hooks: [{ type: 'http', url: 'http://127.0.0.1:50000/claude-pet/hook/Stop' }] });
  assert.equal(hooksDetails(mixed, options).samePort, false);
});

test('addPetHooks refuses settings whose hooks section it does not understand', () => {
  assert.throws(() => addPetHooks({ hooks: 'nope' }, options), /not an object/);
  assert.throws(() => addPetHooks({ hooks: { Stop: { hooks: [] } } }, options), /not a list/);
});

test('installHooks keeps one backup, and uninstallHooks puts the settings back', (t) => {
  const { dir, file } = tempSettings(t, existing);
  // backups left by older versions
  fs.writeFileSync(`${file}${BACKUP_SUFFIX}-2026-09-01T10-00-00-000Z`, '{"old":"secret"}');
  fs.writeFileSync(path.join(dir, 'settings.json.claude-pet-backup-notes.txt'), 'not ours to delete');

  const installed = installHooks({ ...options, file });
  assert.equal(installed.changed, true);
  assert.equal(installed.backupPath, `${file}${BACKUP_SUFFIX}`);
  assert.deepEqual(readJson(installed.backupPath), existing);
  assert.equal(hooksState(readJson(file), options), 'current');

  assert.deepEqual(installHooks({ ...options, file }), { changed: false, backupPath: null }); // nothing to do
  uninstallHooks({ file });
  assert.deepEqual(readJson(file), existing);
  installHooks({ ...options, file });
  uninstallHooks({ file });
  assert.deepEqual(readJson(file), existing);
  assert.deepEqual(uninstallHooks({ file }), { changed: false, backupPath: null });

  assert.deepEqual(fs.readdirSync(dir).sort(), [
    'settings.json', 'settings.json.claude-pet-backup', 'settings.json.claude-pet-backup-notes.txt',
  ]);
});

test('upgradeHooks replaces old HTTP hooks and leaves settings without pet hooks alone', (t) => {
  const { file } = tempSettings(t, oldHttpHooks(existing));
  assert.equal(readHooksState({ ...options, file }).state, 'outdated');
  assert.equal(upgradeHooks({ ...options, file }).changed, true);
  assert.equal(readHooksState({ ...options, file }).state, 'current');
  assert.deepEqual(removePetHooks(readJson(file)), existing);
  assert.equal(upgradeHooks({ ...options, file }).changed, false);

  const other = tempSettings(t, existing);
  assert.deepEqual(upgradeHooks({ ...options, file: other.file }), { changed: false, backupPath: null });
  assert.deepEqual(readJson(other.file), existing);
  assert.equal(fs.existsSync(`${other.file}${BACKUP_SUFFIX}`), false);
});

test('a settings file saved with a byte order mark still works', (t) => {
  const { file } = tempSettings(t, `﻿${JSON.stringify(oldHttpHooks(existing))}`);
  assert.equal(readHooksState({ ...options, file }).state, 'outdated');
  uninstallHooks({ file });
  assert.deepEqual(readJson(file), existing);
});

test('broken or unexpected settings are never overwritten, and the reason is reported', (t) => {
  for (const content of ['{ not json', '[]', 'null']) {
    const { file } = tempSettings(t, content);
    assert.throws(() => installHooks({ ...options, file }), /left untouched/);
    assert.equal(fs.readFileSync(file, 'utf8'), content);
    const { state, error } = readHooksState({ ...options, file });
    assert.equal(state, 'unreadable');
    assert.match(error, /left untouched/);
  }
  const { file } = tempSettings(t);
  assert.equal(readHooksState({ ...options, file }).state, 'missing');
  installHooks({ ...options, file }); // no settings file yet: created, nothing to back up
  assert.equal(readHooksState({ ...options, file }).state, 'current');
});

test('a read-only settings file is left untouched, with no backup or temp file', (t) => {
  const { dir, file } = tempSettings(t, existing);
  fs.chmodSync(file, 0o444);
  assert.throws(() => installHooks({ ...options, file }), /read-only/);
  assert.deepEqual(fs.readdirSync(dir), ['settings.json']);
});

test('a hard-linked settings file stays linked to the real file', (t) => {
  const { dir, file } = tempSettings(t);
  const real = path.join(dir, 'dotfiles-settings.json');
  fs.writeFileSync(real, JSON.stringify(existing));
  fs.linkSync(real, file);
  installHooks({ ...options, file });
  assert.equal(hooksState(readJson(real), options), 'current');
  fs.writeFileSync(real, JSON.stringify({ edited: true }));
  assert.deepEqual(readJson(file), { edited: true });
});

// Runs without the rights real symlinks need: settings.json "resolves" to a file in another folder.
test('a linked settings file is written where the link points, without replacing the link', (t) => {
  const { file } = tempSettings(t, existing);
  const { file: real } = tempSettings(t, { ...existing, model: 'sonnet' });
  const { realpathSync, renameSync } = fs;
  t.mock.method(fs, 'realpathSync', (p, ...rest) => (p === file ? real : realpathSync(p, ...rest)));
  const renames = [];
  t.mock.method(fs, 'renameSync', (from, to) => {
    renames.push([from, to]);
    return renameSync(from, to);
  });
  installHooks({ ...options, file });
  assert.equal(hooksState(readJson(real), options), 'current');
  assert.deepEqual(readJson(file), existing); // the link itself is left as it was
  assert.deepEqual(renames, [[`${real}.claude-pet.tmp`, real]]);
  assert.deepEqual(readJson(`${file}${BACKUP_SUFFIX}`), { ...existing, model: 'sonnet' }); // a copy of the real file
});

// Settings often hold secrets in "env": a file only its owner could read must stay that way.
test('changing the settings file keeps its permissions', (t) => {
  const { file } = tempSettings(t, existing);
  const target = fs.realpathSync(file);
  const { statSync, writeFileSync } = fs;
  t.mock.method(fs, 'statSync', (p, ...rest) => {
    const stats = statSync(p, ...rest);
    return p === target ? Object.assign(Object.create(Object.getPrototypeOf(stats)), stats, { mode: 0o100600 }) : stats;
  });
  const modes = [];
  t.mock.method(fs, 'writeFileSync', (p, text, opts) => {
    if (p === `${target}.claude-pet.tmp`) modes.push(opts?.mode);
    return writeFileSync(p, text, opts);
  });
  installHooks({ ...options, file });
  uninstallHooks({ file });
  assert.deepEqual(modes, [0o600, 0o600]);
});

test('an owner-only settings file stays owner-only after connecting and disconnecting', {
  skip: process.platform === 'win32' && 'Windows does not use permission bits',
}, (t) => {
  const { file } = tempSettings(t, existing);
  fs.chmodSync(file, 0o600);
  installHooks({ ...options, file });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  uninstallHooks({ file });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('a symlinked settings file is written through the link', (t) => {
  const { dir, file } = tempSettings(t);
  const real = path.join(dir, 'dotfiles-settings.json');
  fs.writeFileSync(real, JSON.stringify(existing));
  try {
    fs.symlinkSync(real, file, 'file');
  } catch (err) {
    t.skip(`symlinks need extra rights here (${err.code})`);
    return;
  }
  installHooks({ ...options, file });
  assert.equal(fs.lstatSync(file).isSymbolicLink(), true);
  assert.equal(hooksState(readJson(real), options), 'current');
});
