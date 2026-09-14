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
