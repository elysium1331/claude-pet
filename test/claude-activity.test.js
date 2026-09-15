const test = require('node:test');
const assert = require('node:assert/strict');
const { ClaudeActivity } = require('../src/main/claude-activity');

function tracker(start = 1_000_000) {
  let now = start;
  const activity = new ClaudeActivity({ now: () => now, celebrateAfterMs: 20_000 });
  return { activity, advance: (ms) => { now += ms; } };
}

test('a prompt means thinking, tool use means busy, and nothing going on means null', () => {
  const { activity } = tracker();
  assert.equal(activity.summary(), null);
  assert.deepEqual(activity.handle('UserPromptSubmit', { session_id: 'a' }), []);
  assert.equal(activity.summary(), 'thinking');
  activity.handle('PreToolUse', { session_id: 'a', tool_name: 'Bash' });
  assert.equal(activity.summary(), 'busy');
  activity.handle('PostToolUse', { session_id: 'a', tool_name: 'Bash' });
  assert.equal(activity.summary(), 'thinking');
});

test('a permission prompt rings the bell and waits; using the tool afterwards is an approval', () => {
  const { activity } = tracker();
  activity.handle('UserPromptSubmit', { session_id: 'a' });
  assert.deepEqual(
    activity.handle('Notification', { session_id: 'a', notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' }),
    ['alert'],
  );
  assert.equal(activity.summary(), 'waiting');
  assert.deepEqual(activity.handle('PostToolUse', { session_id: 'a', tool_name: 'Bash' }), ['approve']);
  assert.equal(activity.summary(), 'thinking');
});

test('a PermissionRequest also waits for you, and a failed tool gets an oops', () => {
  const { activity } = tracker();
  activity.handle('PreToolUse', { session_id: 'a', tool_name: 'Bash' });
  assert.deepEqual(activity.handle('PermissionRequest', { session_id: 'a', tool_name: 'Bash' }), ['alert']);
  // the matching Notification right after must not ring the bell twice
  assert.deepEqual(activity.handle('Notification', { session_id: 'a', notification_type: 'permission_prompt' }), []);
  assert.equal(activity.summary(), 'waiting');
  assert.deepEqual(activity.handle('PostToolUseFailure', { session_id: 'a', tool_name: 'Bash' }), ['approve', 'error']);
  assert.equal(activity.summary(), 'thinking');
  assert.deepEqual(activity.handle('PostToolUseFailure', { session_id: 'a', tool_name: 'Bash' }), ['error']);
});

test('an "idle, waiting for your input" notification is not an alert', () => {
  const { activity } = tracker();
  assert.deepEqual(activity.handle('Notification', { session_id: 'a', notification_type: 'idle_prompt' }), []);
  assert.deepEqual(activity.handle('Notification', { session_id: 'b', message: 'Claude is waiting for your input' }), []);
  assert.equal(activity.summary(), null);
});

test('Stop celebrates only turns that took a while, then goes quiet', () => {
  const { activity, advance } = tracker();
  activity.handle('UserPromptSubmit', { session_id: 'a' });
  advance(5_000);
  assert.deepEqual(activity.handle('Stop', { session_id: 'a' }), []); // quick reply: no party
  assert.equal(activity.summary(), null);

  activity.handle('UserPromptSubmit', { session_id: 'a' });
  advance(45_000);
  assert.deepEqual(activity.handle('Stop', { session_id: 'a' }), ['taskDone']);
  assert.equal(activity.summary(), null);
});

test('the most urgent session wins across several sessions', () => {
  const { activity } = tracker();
  activity.handle('UserPromptSubmit', { session_id: 'a' });
  activity.handle('PreToolUse', { session_id: 'b' });
  assert.equal(activity.summary(), 'busy');
  activity.handle('Notification', { session_id: 'c', notification_type: 'permission_prompt' });
  assert.equal(activity.summary(), 'waiting');
  activity.handle('SessionEnd', { session_id: 'c' });
  assert.equal(activity.summary(), 'busy');
});

test('an idle prompt ends a turn that was interrupted or had its permission denied', () => {
  const { activity } = tracker();
  activity.handle('UserPromptSubmit', { session_id: 'a' });
  activity.handle('PreToolUse', { session_id: 'a', tool_name: 'Bash' });
  activity.handle('PermissionRequest', { session_id: 'a', tool_name: 'Bash' });
  assert.equal(activity.summary(), 'waiting');
  // you pick No (or press Esc): no Stop comes, but Claude Code says it is idle a minute later
  assert.deepEqual(activity.handle('Notification', { session_id: 'a', notification_type: 'idle_prompt' }), []);
  assert.equal(activity.summary(), null);

  activity.handle('UserPromptSubmit', { session_id: 'b' });
  activity.handle('PreToolUse', { session_id: 'b', tool_name: 'Bash' }); // Esc while the tool runs
  assert.equal(activity.summary(), 'busy');
  activity.handle('Notification', { session_id: 'b', notification_type: 'idle_prompt' });
  assert.equal(activity.summary(), null);
});

test('other tools finishing while a permission prompt is open are not an approval', () => {
  const { activity } = tracker();
  activity.handle('UserPromptSubmit', { session_id: 'a' });
  activity.handle('PreToolUse', { session_id: 'a', tool_name: 'Task', tool_use_id: 't1' });
  activity.handle('PreToolUse', { session_id: 'a', tool_name: 'Grep', tool_use_id: 't2', agent_id: 'sub1' });
  activity.handle('PreToolUse', { session_id: 'a', tool_name: 'Bash', tool_use_id: 't3', agent_id: 'sub2' });
  assert.deepEqual(activity.handle('PermissionRequest', { session_id: 'a', tool_name: 'Bash', agent_id: 'sub2' }), ['alert']);
  assert.deepEqual(activity.handle('Notification', { session_id: 'a', notification_type: 'permission_prompt' }), []);

  assert.deepEqual(activity.handle('PostToolUse', { session_id: 'a', tool_name: 'Grep', tool_use_id: 't2', agent_id: 'sub1' }), []);
  activity.handle('PreToolUse', { session_id: 'a', tool_name: 'Read', tool_use_id: 't4', agent_id: 'sub1' });
  assert.deepEqual(activity.handle('PostToolUseFailure', { session_id: 'a', tool_name: 'Read', tool_use_id: 't4', agent_id: 'sub1' }), ['error']);
  // a Bash call from another subagent doesn't answer sub2's prompt either
  assert.deepEqual(activity.handle('PostToolUse', { session_id: 'a', tool_name: 'Bash', tool_use_id: 't5', agent_id: 'sub1' }), []);
  assert.equal(activity.summary(), 'waiting');

  assert.deepEqual(activity.handle('PostToolUse', { session_id: 'a', tool_name: 'Bash', tool_use_id: 't3', agent_id: 'sub2' }), ['approve']);
  assert.equal(activity.summary(), 'thinking');
});

test('a prompt for one of two running calls of the same tool is matched by its input', () => {
  const { activity } = tracker();
  activity.handle('PreToolUse', { session_id: 'a', tool_name: 'WebFetch', tool_use_id: 'w1', tool_input: { url: 'https://allowed.example' } });
  activity.handle('PreToolUse', { session_id: 'a', tool_name: 'WebFetch', tool_use_id: 'w2', tool_input: { url: 'https://new.example' } });
  activity.handle('PermissionRequest', { session_id: 'a', tool_name: 'WebFetch', tool_input: { url: 'https://new.example' } });
  assert.deepEqual(activity.handle('PostToolUse', { session_id: 'a', tool_name: 'WebFetch', tool_use_id: 'w1' }), []);
  assert.equal(activity.summary(), 'waiting');
  assert.deepEqual(activity.handle('PostToolUse', { session_id: 'a', tool_name: 'WebFetch', tool_use_id: 'w2' }), ['approve']);
  assert.equal(activity.summary(), 'thinking');
});

test('a Notification that arrives before its PermissionRequest still rings once and waits for the right tool', () => {
  const { activity } = tracker();
  assert.deepEqual(activity.handle('Notification', { session_id: 'a', notification_type: 'permission_prompt' }), ['alert']);
  assert.deepEqual(activity.handle('PermissionRequest', { session_id: 'a', tool_name: 'Bash' }), []);
  assert.deepEqual(activity.handle('PostToolUse', { session_id: 'a', tool_name: 'Grep' }), []);
  assert.deepEqual(activity.handle('PostToolUse', { session_id: 'a', tool_name: 'Bash' }), ['approve']);
});

test('odd payloads never throw', () => {
  const { activity } = tracker();
  for (const payload of [null, undefined, 42, 'text', [], { session_id: 12345 }, { session_id: { a: 1 } }, { session_id: '' }]) {
    for (const event of ['UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'Notification', 'Stop', 'SessionEnd']) {
      activity.handle(event, payload);
    }
  }
  activity.handle('PreToolUse', { session_id: 12345 });
  assert.deepEqual([...activity.sessions.keys()], ['default']);
  assert.equal(activity.summary(), 'busy');
});

test('session ids are capped in length and sessions in number', () => {
  const { activity, advance } = tracker();
  activity.handle('PreToolUse', { session_id: 'x'.repeat(100_000) });
  assert.equal([...activity.sessions.keys()][0].length, 128);
  for (let i = 0; i < 500; i += 1) {
    advance(1);
    activity.handle('PermissionRequest', { session_id: `s${i}` });
  }
  assert.equal(activity.sessions.size, 64);
  assert.ok(activity.sessions.has('s499'));
  assert.ok(!activity.sessions.has('s0'));
});

test('sessions that go silent (crashed or closed) are forgotten', () => {
  const { activity, advance } = tracker();
  activity.handle('PreToolUse', { session_id: 'a' });
  advance(11 * 60_000);
  assert.equal(activity.summary(), null);

  activity.handle('Notification', { session_id: 'b', notification_type: 'permission_prompt' });
  advance(20 * 60_000);
  assert.equal(activity.summary(), 'waiting'); // a pending permission is remembered longer
  advance(11 * 60_000);
  assert.equal(activity.summary(), null);
});
