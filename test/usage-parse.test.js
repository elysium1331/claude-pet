process.env.TZ = 'America/New_York';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseUsage,
  levelFor,
  colorForPercent,
  choosePetState,
  formatReset,
  formatCountdown,
  formatAgo,
  hasUsage,
  fillUnknownPercents,
  usageAsOf,
  pickScoped,
} = require('../src/main/usage-parse');
const sample = require('./fixtures/usage-response.json');

test('parseUsage reads session, weekly and scoped limits from limits[]', () => {
  const u = parseUsage(sample);
  assert.equal(u.session.percent, 7);
  assert.equal(u.session.label, 'Session');
  assert.equal(u.session.resetsAt.toISOString(), '2026-09-14T18:00:00.440Z');
  assert.equal(u.weekly.percent, 36);
  assert.equal(u.weekly.label, 'Weekly');
  assert.equal(u.scoped.length, 1);
  assert.equal(u.scoped[0].label, 'Fable');
  assert.equal(u.scoped[0].percent, 67);
});

test('parseUsage falls back to legacy five_hour / seven_day fields', () => {
  const u = parseUsage({
    five_hour: { utilization: 12, resets_at: '2026-09-14T18:00:00Z' },
    seven_day: { utilization: 40, resets_at: '2026-09-20T21:00:00Z' },
    seven_day_opus: { utilization: 55, resets_at: '2026-09-20T21:00:00Z' },
    seven_day_sonnet: null,
  });
  assert.equal(u.session.percent, 12);
  assert.equal(u.weekly.percent, 40);
  assert.deepEqual(u.scoped.map((m) => [m.label, m.percent]), [['Opus', 55]]);
});

test('parseUsage clamps percents and tolerates missing or junk data', () => {
  const u = parseUsage({ limits: [{ kind: 'session', percent: 104, resets_at: null }] });
  assert.equal(u.session.percent, 100);
  assert.equal(u.session.resetsAt, null);
  assert.equal(u.weekly, null);
  assert.deepEqual(u.scoped, []);

  const empty = parseUsage(null);
  assert.equal(empty.session, null);
  assert.equal(empty.weekly, null);
  assert.deepEqual(empty.scoped, []);
});

test('parseUsage reads a missing or junk percent as unknown, not 0%', () => {
  const u = parseUsage({
    limits: [
      { kind: 'session', percent: null },
      { kind: 'weekly_all' },
      { kind: 'weekly_scoped', percent: 'lots', scope: { model: 'Opus' } },
    ],
  });
  assert.equal(u.session.percent, null);
  assert.equal(u.weekly.percent, null);
  assert.equal(u.scoped[0].percent, null);
  assert.equal(hasUsage(u), false);
  assert.equal(hasUsage(parseUsage({})), false);
  assert.equal(hasUsage(parseUsage({ error: { type: 'overloaded' } })), false);
  assert.equal(hasUsage(parseUsage(sample)), true);
  assert.equal(parseUsage({ limits: [{ kind: 'session', percent: '42' }] }).session.percent, 42);
  assert.equal(parseUsage({ limits: [{ kind: 'session', percent: true }] }).session.percent, null);
  assert.equal(colorForPercent(null), '#8ec5ff');
});

test('fillUnknownPercents carries the last value forward, or leaves out a meter never seen with a number', () => {
  const prev = parseUsage(sample);
  const next = parseUsage({
    limits: sample.limits.map((l) => (l.kind === 'weekly_all' ? l : { ...l, percent: null })),
  });
  const filled = fillUnknownPercents(next, prev);
  assert.equal(filled.session.percent, 7);
  assert.equal(filled.weekly.percent, 36);
  assert.equal(filled.scoped[0].percent, 67);
  const fresh = fillUnknownPercents(next, null);
  assert.equal(fresh.session, null);
  assert.equal(fresh.weekly.percent, 36);
  assert.deepEqual(fresh.scoped, []);
});

test('scoped limits always get distinct labels and ids, from string names only', () => {
  const scoped = (scope, percent) => ({ kind: 'weekly_scoped', percent, scope });
  const u = parseUsage({
    limits: [
      scoped(null, 50),
      scoped({}, 100),
      scoped({ model: { display_name: 'Opus' }, surface: { name: 'code' } }, 40),
      scoped({ model: { display_name: 'Opus' }, surface: 'chat' }, 10),
      scoped({ model: { display_name: 7, name: 'Fable' } }, 5),
      scoped({ model: { display_name: 42 } }, 1),
    ],
  });
  assert.deepEqual(u.scoped.map((m) => m.label), ['Scoped', 'Scoped 2', 'Opus (code)', 'Opus (chat)', 'Fable', 'Scoped 3']);
  assert.equal(new Set(u.scoped.map((m) => m.id)).size, 6);
  assert.equal(parseUsage(sample).scoped[0].id, 'scoped:Fable');
});

test('pickScoped finds the configured limit and never throws on odd values', () => {
  const u = parseUsage({
    limits: [
      { kind: 'weekly_scoped', percent: 10, scope: { model: 'Opus', surface: 'code' } },
      { kind: 'weekly_scoped', percent: 20, scope: { model: 'Opus', surface: 'chat' } },
    ],
  });
  assert.equal(pickScoped(u, 'opus (chat)').percent, 20);
  assert.equal(pickScoped(u, ' Opus (code) ').percent, 10);
  assert.equal(pickScoped(u, 42).percent, 10);
  assert.equal(pickScoped(u, null).percent, 10);
  assert.equal(pickScoped(null, 'Opus'), null);
  assert.equal(pickScoped({ scoped: [{ id: 'x', label: 5, percent: 1 }] }, 'fable').id, 'x');
});

test('usageAsOf shows a meter as reset once its reset time passed after the numbers were fetched', () => {
  const fetchedAt = new Date('2026-09-14T17:00:00Z');
  const u = parseUsage({
    limits: [
      { kind: 'session', percent: 100, resets_at: '2026-09-14T18:00:00Z' },
      { kind: 'weekly_all', percent: 36, resets_at: '2026-09-20T21:00:00Z' },
    ],
  });
  const nextDay = new Date('2026-09-15T09:00:00Z');
  const later = usageAsOf(u, fetchedAt, nextDay);
  assert.equal(later.session.percent, 0);
  assert.equal(later.session.resetPassed, true);
  assert.equal(later.session.resetsAt, null);
  assert.equal(later.weekly.percent, 36);
  assert.equal(u.session.percent, 100); // the snapshot itself is not changed
  assert.equal(usageAsOf(u, fetchedAt, new Date('2026-09-14T17:30:00Z')).session.percent, 100);
  // the server already knew that reset time when it answered: trust its numbers
  assert.equal(usageAsOf(u, new Date('2026-09-14T18:01:00Z'), nextDay).session.percent, 100);
  assert.equal(usageAsOf(u, null, nextDay).session.percent, 0);
  assert.equal(usageAsOf(null, fetchedAt, nextDay), null);
  assert.equal(choosePetState({ claudeRunning: true, usage: later }), 'idle');
  assert.equal(choosePetState({ claudeRunning: true, usage: u }), 'limitReached');
});

test('choosePetState lets the sign-in prompt win over saved numbers that cannot be checked', () => {
  const maxed = parseUsage({ limits: [{ kind: 'session', percent: 100 }] });
  assert.equal(choosePetState({ claudeRunning: true, usage: maxed, needsLogin: true }), 'disconnected');
  const unknown = parseUsage({ limits: [{ kind: 'session', percent: null }] });
  assert.equal(choosePetState({ claudeRunning: true, usage: unknown }), 'idle');
});

test('colorForPercent blends blue -> yellow -> orange -> red as usage climbs', () => {
  assert.equal(colorForPercent(0), '#8ec5ff');
  assert.equal(colorForPercent(50), '#8ec5ff');
  assert.equal(colorForPercent(67), '#eed168'); // most of the way to yellow: clearly heading toward the red zone
  assert.equal(colorForPercent(70), '#ffd34d');
  assert.equal(colorForPercent(85), '#ff9b3d');
  assert.equal(colorForPercent(100), '#ff4f45');
  assert.equal(colorForPercent(140), '#ff4f45');
  assert.equal(colorForPercent(-5), '#8ec5ff');
});

test('levelFor matches the orb color bands', () => {
  assert.equal(levelFor(0), 'calm');
  assert.equal(levelFor(69.9), 'calm');
  assert.equal(levelFor(70), 'warm');
  assert.equal(levelFor(89.9), 'warm');
  assert.equal(levelFor(90), 'hot');
});

test('choosePetState picks sleeping / idle / lowUsage / limitReached', () => {
  const u = parseUsage(sample);
  assert.equal(choosePetState({ claudeRunning: false, usage: u }), 'sleeping');
  assert.equal(choosePetState({ claudeRunning: true, usage: null }), 'idle');
  assert.equal(choosePetState({ claudeRunning: true, usage: u }), 'idle');

  const high = parseUsage({ limits: [{ kind: 'weekly_all', percent: 88 }] });
  assert.equal(choosePetState({ claudeRunning: true, usage: high }), 'lowUsage');
  assert.equal(choosePetState({ claudeRunning: true, usage: high, warnAt: 90 }), 'idle');

  const maxed = parseUsage({ limits: [{ kind: 'session', percent: 100 }] });
  assert.equal(choosePetState({ claudeRunning: true, usage: maxed }), 'limitReached');
});

test('choosePetState lounges when left alone, sleeps when you are away, and flags sign-in problems', () => {
  const u = parseUsage(sample);
  const base = { claudeRunning: true, usage: u, loungeAfterMs: 180_000, awayAfterMs: 600_000 };
  assert.equal(choosePetState({ ...base, petIdleMs: 179_000 }), 'idle');
  assert.equal(choosePetState({ ...base, petIdleMs: 180_000 }), 'lounging');
  assert.equal(choosePetState({ ...base, petIdleMs: 999_000, userAwayMs: 600_000 }), 'sleeping');
  assert.equal(choosePetState({ ...base, needsLogin: true }), 'disconnected');

  // Claude Code activity
  assert.equal(choosePetState({ ...base, activity: 'thinking', petIdleMs: 999_000 }), 'working');
  assert.equal(choosePetState({ ...base, activity: 'busy' }), 'workingBusy');
  assert.equal(choosePetState({ ...base, activity: 'waiting', userAwayMs: 999_000 }), 'needsAttention');
  assert.equal(choosePetState({ ...base, claudeRunning: false, activity: 'waiting' }), 'needsAttention');
  assert.equal(choosePetState({ ...base, activity: 'busy', userAwayMs: 999_000 }), 'workingBusy'); // working while you're away
  assert.equal(choosePetState({ ...base, activity: 'busy', needsLogin: true }), 'workingBusy');
  const maxedOut = parseUsage({ limits: [{ kind: 'session', percent: 100 }] });
  assert.equal(choosePetState({ ...base, usage: maxedOut, activity: 'busy' }), 'limitReached');

  // Claude activity doesn't reset the lounge timer; it only needs a short quiet spell afterwards
  assert.equal(choosePetState({ ...base, petIdleMs: 999_000, claudeQuietMs: 10_000 }), 'idle');
  assert.equal(choosePetState({ ...base, petIdleMs: 999_000, claudeQuietMs: 30_000 }), 'lounging');
  assert.equal(choosePetState({ ...base, petIdleMs: 60_000, claudeQuietMs: 999_000 }), 'idle');

  // usage went up recently (e.g. a Claude chat): stays perked up for a few minutes instead of chilling
  assert.equal(choosePetState({ ...base, petIdleMs: 999_000, usageQuietMs: 60_000 }), 'idle');
  assert.equal(choosePetState({ ...base, petIdleMs: 999_000, usageQuietMs: 180_000 }), 'lounging');

  // worry beats lounging so a near-limit warning is never hidden
  const high = parseUsage({ limits: [{ kind: 'weekly_all', percent: 88 }] });
  assert.equal(choosePetState({ ...base, usage: high, petIdleMs: 999_000 }), 'lowUsage');
});

test('formatReset shows a time today, or weekday + time later', () => {
  const now = new Date('2026-09-14T17:03:00Z'); // Mon 1:03 PM in New York
  assert.equal(formatReset(new Date('2026-09-14T18:00:00Z'), now, 'en-US'), '2:00 PM');
  assert.equal(formatReset(new Date('2026-09-20T21:00:00Z'), now, 'en-US'), 'Sun 5:00 PM');
  assert.equal(formatReset(null, now, 'en-US'), '');
  // reset timestamps can land a hair before the minute
  assert.equal(formatReset(new Date('2026-09-20T20:59:59.900Z'), now, 'en-US'), 'Sun 5:00 PM');
});

test('formatCountdown gives a compact time remaining', () => {
  const now = new Date('2026-09-14T17:03:00Z');
  assert.equal(formatCountdown(new Date('2026-09-14T18:00:00Z'), now), '57m');
  assert.equal(formatCountdown(new Date('2026-09-14T20:00:00Z'), now), '2h 57m');
  assert.equal(formatCountdown(new Date('2026-09-20T21:00:00Z'), now), '6d 3h');
  assert.equal(formatCountdown(new Date('2026-09-14T17:00:00Z'), now), 'now');
  assert.equal(formatCountdown(null, now), '');
});

test('formatAgo describes how old the data is', () => {
  const now = new Date('2026-09-14T17:03:00Z');
  assert.equal(formatAgo(new Date('2026-09-14T17:02:30Z'), now), 'just now');
  assert.equal(formatAgo(new Date('2026-09-14T16:51:00Z'), now), '12m ago');
  assert.equal(formatAgo(new Date('2026-09-14T14:00:00Z'), now), '3h ago');
  assert.equal(formatAgo(null, now), '');
});
