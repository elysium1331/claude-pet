// Pure helpers for turning the usage endpoint response into what the pet displays.
// No Electron or network code here so it can be unit tested with `node --test`.

const LEGACY_SCOPED = [
  ['seven_day_opus', 'Opus'],
  ['seven_day_sonnet', 'Sonnet'],
];

const nonEmptyString = (v) => typeof v === 'string' && v.trim() !== '';

// A percent the server didn't give (null, missing, not a number) is unknown (null), not 0%.
function clampPercent(value) {
  const n = typeof value === 'number' || nonEmptyString(value) ? Number(value) : Number.NaN;
  if (!Number.isFinite(n)) return null;
  return Math.min(100, Math.max(0, n));
}

function toDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function meter(id, label, percent, resetsAt, severity) {
  return {
    id,
    label,
    percent: clampPercent(percent),
    resetsAt: toDate(resetsAt),
    severity: severity || 'normal',
  };
}

function scopeName(part) {
  if (nonEmptyString(part)) return part.trim();
  const name = [part?.display_name, part?.name, part?.id].find(nonEmptyString);
  return name ? name.trim() : null;
}

// Scoped meters are told apart (and picked in settings) by label, so labels that would repeat get the surface
// name added, then a number.
function uniqueScopeLabels(scopes) {
  const base = scopes.map((s) => s.model || s.surface || 'Scoped');
  const used = new Set();
  return scopes.map((s, i) => {
    let label = base[i];
    if (s.model && s.surface && base.filter((b) => b === label).length > 1) label = `${s.model} (${s.surface})`;
    let candidate = label;
    for (let n = 2; used.has(candidate); n += 1) candidate = `${label} ${n}`;
    used.add(candidate);
    return candidate;
  });
}

function parseUsage(raw) {
  const result = { session: null, weekly: null, scoped: [] };
  if (!raw || typeof raw !== 'object') return result;

  const limits = Array.isArray(raw.limits) ? raw.limits : [];
  if (limits.length) {
    const scoped = [];
    for (const l of limits) {
      if (!l || typeof l !== 'object') continue;
      if (l.kind === 'session' && !result.session) {
        result.session = meter('session', 'Session', l.percent, l.resets_at, l.severity);
      } else if (l.kind === 'weekly_all' && !result.weekly) {
        result.weekly = meter('weekly', 'Weekly', l.percent, l.resets_at, l.severity);
      } else if (l.kind === 'weekly_scoped') {
        scoped.push({ limit: l, model: scopeName(l.scope?.model), surface: scopeName(l.scope?.surface) });
      }
    }
    const labels = uniqueScopeLabels(scoped);
    result.scoped = scoped.map(({ limit: l }, i) => meter(`scoped:${labels[i]}`, labels[i], l.percent, l.resets_at, l.severity));
    return result;
  }

  // Older response shape without limits[].
  if (raw.five_hour) result.session = meter('session', 'Session', raw.five_hour.utilization, raw.five_hour.resets_at);
  if (raw.seven_day) result.weekly = meter('weekly', 'Weekly', raw.seven_day.utilization, raw.seven_day.resets_at);
  for (const [key, label] of LEGACY_SCOPED) {
    const v = raw[key];
    if (v) result.scoped.push(meter(`scoped:${label}`, label, v.utilization, v.resets_at));
  }
  return result;
}

function allMeters(usage) {
  if (!usage) return [];
  return [usage.session, usage.weekly, ...(usage.scoped || [])].filter(Boolean);
}

// Whether a parsed response has any real numbers in it (an error body or a changed format has none).
function hasUsage(usage) {
  return allMeters(usage).some((m) => Number.isFinite(m.percent));
}

// Reset times are compared to within a minute, since the server's carry fractions of a second.
const SAME_WINDOW_MS = 60_000;

// Meters that came without a percent keep their last known value while it still describes the same window (the same
// reset time, not yet passed). Otherwise they are left out rather than showing the previous window's number.
function fillUnknownPercents(next, prev, now = new Date()) {
  const sameWindow = (m, old) => {
    const reset = m.resetsAt?.getTime();
    const oldReset = old.resetsAt?.getTime();
    if (reset === undefined || oldReset === undefined) return reset === oldReset;
    return Math.abs(reset - oldReset) < SAME_WINDOW_MS && oldReset > now.getTime();
  };
  const fill = (m, old) => {
    if (!m || Number.isFinite(m.percent)) return m;
    return old && Number.isFinite(old.percent) && sameWindow(m, old) ? { ...m, percent: old.percent } : null;
  };
  return {
    session: fill(next.session, prev?.session),
    weekly: fill(next.weekly, prev?.weekly),
    scoped: (next.scoped || []).map((m) => fill(m, prev?.scoped?.find((o) => o.id === m.id))).filter(Boolean),
  };
}

// Numbers fetched before a meter's reset time no longer apply once that time has passed: that meter reads as reset
// (0%, resetPassed) until the next successful check brings real numbers.
function usageAsOf(usage, fetchedAt, now = new Date()) {
  if (!usage) return usage;
  const fetched = fetchedAt instanceof Date && Number.isFinite(fetchedAt.getTime()) ? fetchedAt.getTime() : -Infinity;
  const current = (m) => {
    const reset = m?.resetsAt?.getTime();
    if (!m || !Number.isFinite(reset) || reset > now.getTime() || reset <= fetched) return m;
    return { ...m, percent: 0, resetsAt: null, resetPassed: true };
  };
  return { session: current(usage.session), weekly: current(usage.weekly), scoped: (usage.scoped || []).map(current) };
}

// The per-model meter for the third orb: the one named in settings, otherwise the first reported.
function pickScoped(usage, wanted) {
  const scoped = usage?.scoped || [];
  const name = nonEmptyString(wanted) ? wanted.trim().toLowerCase() : '';
  return (name && scoped.find((m) => typeof m.label === 'string' && m.label.toLowerCase() === name)) || scoped[0] || null;
}

// Meter color scale: calm blue until half used, then yellow -> orange -> red approaching the limit.
const COLOR_STOPS = [
  [0, [0x8e, 0xc5, 0xff]],
  [50, [0x8e, 0xc5, 0xff]],
  [70, [0xff, 0xd3, 0x4d]],
  [85, [0xff, 0x9b, 0x3d]],
  [100, [0xff, 0x4f, 0x45]],
];

function colorForPercent(percent) {
  const p = clampPercent(percent) ?? 0;
  let i = 1;
  while (i < COLOR_STOPS.length - 1 && p > COLOR_STOPS[i][0]) i += 1;
  const [p0, c0] = COLOR_STOPS[i - 1];
  const [p1, c1] = COLOR_STOPS[i];
  const t = p1 === p0 ? 1 : Math.min(1, Math.max(0, (p - p0) / (p1 - p0)));
  return `#${c0.map((v, k) => Math.round(v + (c1[k] - v) * t).toString(16).padStart(2, '0')).join('')}`;
}

function levelFor(percent) {
  if (percent >= 90) return 'hot';
  if (percent >= 70) return 'warm';
  return 'calm';
}

function choosePetState({
  claudeRunning,
  usage,
  warnAt = 85,
  needsLogin = false,
  userAwayMs = 0, // time since any keyboard/mouse input on the computer
  petIdleMs = 0, // time since the pet itself was touched
  loungeAfterMs = 3 * 60_000,
  awayAfterMs = 10 * 60_000,
  activity = null, // Claude Code: 'waiting' | 'busy' | 'thinking' | null
  claudeQuietMs = Infinity, // time since the last Claude Code event
  loungeGraceMs = 30_000, // after Claude goes quiet, wait this long before lying back down
  usageQuietMs = Infinity, // time since usage last went up (catches Claude chat, which sends no hooks)
  perkWindowMs = 180_000, // after usage goes up, stay perked up this long
}) {
  if (activity === 'waiting') return 'needsAttention';
  if (!claudeRunning && !activity) return 'sleeping';
  // Signed out, the saved numbers can't be checked, so they must not hide the sign-in prompt.
  const worst = needsLogin ? 0 : Math.max(0, ...allMeters(usage).map((m) => m.percent).filter(Number.isFinite));
  if (worst >= 100) return 'limitReached';
  if (activity === 'busy') return 'workingBusy';
  if (activity === 'thinking') return 'working';
  if (userAwayMs >= awayAfterMs) return 'sleeping';
  if (needsLogin) return 'disconnected';
  if (worst >= warnAt) return 'lowUsage';
  if (petIdleMs >= loungeAfterMs && claudeQuietMs >= loungeGraceMs && usageQuietMs >= perkWindowMs) return 'lounging';
  return 'idle';
}

function sameLocalDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function formatReset(date, now = new Date(), locale) {
  if (!date) return '';
  const rounded = new Date(Math.round(date.getTime() / 60000) * 60000);
  const time = rounded.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });
  const text = sameLocalDay(rounded, now)
    ? time
    : `${rounded.toLocaleDateString(locale, { weekday: 'short' })} ${time}`;
  return text.replace(/[  ]/g, ' '); // newer ICU puts a narrow no-break space before AM/PM
}

function formatCountdown(date, now = new Date()) {
  if (!date) return '';
  const minutes = Math.floor((date.getTime() - now.getTime()) / 60000);
  if (minutes <= 0) return 'now';
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

function formatAgo(date, now = new Date()) {
  if (!date) return '';
  const minutes = Math.floor((now.getTime() - date.getTime()) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}

module.exports = {
  parseUsage,
  allMeters,
  hasUsage,
  fillUnknownPercents,
  usageAsOf,
  pickScoped,
  levelFor,
  colorForPercent,
  choosePetState,
  formatReset,
  formatCountdown,
  formatAgo,
};
