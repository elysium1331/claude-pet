const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  addPetHooks, removePetHooks, hasPetHooks, isPetHook, installHooks, uninstallHooks, hooksInstalled, HOOK_EVENTS,
} = require('../src/main/hooks-installer');

const userHook = { type: 'command', command: 'echo my own hook' };
const existing = {
  model: 'opus',
  hooks: {
    PreToolUse: [{ matcher: 'Bash', hooks: [userHook] }],
    Stop: [{ hooks: [userHook] }],
  },
};

test('addPetHooks adds one pet hook per event and keeps everything else', () => {
  const next = addPetHooks(existing, 47821);
  assert.equal(next.model, 'opus');
  for (const event of HOOK_EVENTS.map((e) => e.event)) {
    const petHooks = next.hooks[event].flatMap((g) => g.hooks).filter(isPetHook);
    assert.equal(petHooks.length, 1, event);
    assert.equal(petHooks[0].type, 'http');
    assert.equal(petHooks[0].url, `http://127.0.0.1:47821/claude-pet/hook/${event}`);
  }
  assert.deepEqual(next.hooks.PreToolUse[0], { matcher: 'Bash', hooks: [userHook] });
  assert.deepEqual(next.hooks.Stop[0], { hooks: [userHook] });
  assert.equal(hasPetHooks(next), true);
  // the input object is not modified
  assert.equal(existing.hooks.PreToolUse.length, 1);
});

test('addPetHooks is idempotent and can change the port', () => {
  const twice = addPetHooks(addPetHooks(existing, 47821), 50000);
  const petHooks = Object.values(twice.hooks).flat().flatMap((g) => g.hooks).filter(isPetHook);
  assert.equal(petHooks.length, HOOK_EVENTS.length);
  assert.ok(petHooks.every((h) => h.url.includes(':50000/')));
});

test('removePetHooks restores the original settings exactly', () => {
  assert.deepEqual(removePetHooks(addPetHooks(existing, 47821)), existing);
  assert.equal(hasPetHooks(existing), false);
});

test('installHooks backs up the file, and uninstallHooks puts the settings back', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pet-hooks-'));
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, JSON.stringify(existing));

  const { backupPath } = installHooks(47821, file);
  assert.ok(fs.existsSync(backupPath));
  assert.deepEqual(JSON.parse(fs.readFileSync(backupPath, 'utf8')), existing);
  assert.equal(hooksInstalled(file), true);

  uninstallHooks(file);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), existing);
  assert.equal(hooksInstalled(file), false);

  // a broken settings file is never overwritten
  fs.writeFileSync(file, '{ not json');
  assert.throws(() => installHooks(47821, file), /not valid JSON/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{ not json');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('removePetHooks cleans up empty sections it created', () => {
  const fresh = addPetHooks({}, 47821);
  assert.deepEqual(removePetHooks(fresh), {});
  assert.deepEqual(removePetHooks({ theme: 'dark' }), { theme: 'dark' });
});
