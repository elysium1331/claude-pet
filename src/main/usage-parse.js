// Pure helpers for turning the usage endpoint response into what the pet displays.
// No Electron or network code here so it can be unit tested with `node --test`.

const LEGACY_SCOPED = [
  ['seven_day_opus', 'Opus'],
  ['seven_day_sonnet', 'Sonnet'],
];

function clampPercent(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
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

function scopeLabel(scope) {
  const pick = (part) => (typeof part === 'string' ? part : part?.display_name || part?.name || part?.id);
  return pick(scope?.model) || pick(scope?.surface) || 'Scoped';
}

function parseUsage(raw) {
  const result = { session: null, weekly: null, scoped: [] };
  if (!raw || typeof raw !== 'object') return result;

  const limits = Array.isArray(raw.limits) ? raw.limits : [];
  if (limits.length) {
    for (const l of limits) {
      if (!l || typeof l !== 'object') continue;
      if (l.kind === 'session' && !result.session) {
        result.session = meter('session', 'Session', l.percent, l.resets_at, l.severity);
      } else if (l.kind === 'weekly_all' && !result.weekly) {
        result.weekly = meter('weekly', 'Weekly', l.percent, l.resets_at, l.severity);
      } else if (l.kind === 'weekly_scoped') {
        const label = scopeLabel(l.scope);
        result.scoped.push(meter(`scoped:${label}`, label, l.percent, l.resets_at, l.severity));
      }
    }
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

// Meter color scale: calm blue until half used, then yellow -> orange -> red approaching the limit.
const COLOR_STOPS = [
  [0, [0x8e, 0xc5, 0xff]],
  [50, [0x8e, 0xc5, 0xff]],
  [70, [0xff, 0xd3, 0x4d]],
  [85, [0xff, 0x9b, 0x3d]],
  [100, [0xff, 0x4f, 0x45]],
];

function colorForPercent(percent) {
  const p = clampPercent(percent);
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
}) {
  if (!claudeRunning) return 'sleeping';
  if (userAwayMs >= awayAfterMs) return 'sleeping';
  if (needsLogin) return 'needsAttention';
  const worst = Math.max(0, ...allMeters(usage).map((m) => m.percent));
  if (worst >= 100) return 'limitReached';
  if (worst >= warnAt) return 'lowUsage';
  if (petIdleMs >= loungeAfterMs) return 'lounging';
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
  levelFor,
  colorForPercent,
  choosePetState,
  formatReset,
  formatCountdown,
  formatAgo,
};
