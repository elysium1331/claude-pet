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
