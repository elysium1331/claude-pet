// The pet's happiness and experience. Pure functions over a plain object so it can be unit tested and saved as JSON.
const { localDateKey } = require('./behavior');

const LEVEL_XP = [0, 30, 120, 300]; // xp needed for growth levels 0–3
const HAPPINESS_START = 60;
const HAPPINESS_FLOOR = 20;
const HAPPINESS_DECAY_PER_HOUR = 2;
const DAILY_PLAY_XP_CAP = 30;
const DECAY_EVERY_MS = 60_000;

const REWARDS = {
  petted: { happiness: 6, xp: 1, play: true },
  tickled: { happiness: 4, xp: 1, play: true },
  fed: { happiness: 10, xp: 2, play: true, cooldownMs: 20 * 60_000 },
  played: { happiness: 6, xp: 2, play: true },
  trick: { happiness: 3, xp: 1, play: true },
  taskDone: { happiness: 2, xp: 3 },
};

function newLife(now = Date.now()) {
  return { happiness: HAPPINESS_START, xp: 0, level: 0, updatedAt: now, lastFedAt: null, playXp: { date: null, amount: 0 } };
}

function levelForXp(xp) {
  let level = 0;
  LEVEL_XP.forEach((needed, i) => {
    if (xp >= needed) level = i;
  });
  return level;
}

// A saved life read back from disk, with anything missing or nonsensical replaced by a fresh value.
function sanitizeLife(raw, now = Date.now()) {
  const fresh = newLife(now);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fresh;
  const inRange = (v, min, max, fallback) => (Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback);
  const xp = Math.round(inRange(raw.xp, 0, Number.MAX_SAFE_INTEGER, 0));
  const play = raw.playXp;
  const playXp = play && (play.date === null || typeof play.date === 'string') && Number.isFinite(play.amount)
    ? { date: play.date, amount: Math.max(0, play.amount) }
    : fresh.playXp;
  return {
    happiness: inRange(raw.happiness, 0, 100, fresh.happiness),
    xp,
    level: levelForXp(xp),
    updatedAt: inRange(raw.updatedAt, 0, Number.MAX_SAFE_INTEGER, now),
    lastFedAt: Number.isFinite(raw.lastFedAt) ? raw.lastFedAt : null,
    playXp,
  };
}

// Also true when updatedAt is in the future (the clock was moved back), so decay picks up from now again.
function needsDecay(life, now = Date.now()) {
  return Math.abs(now - life.updatedAt) > DECAY_EVERY_MS;
}

function decay(life, now = Date.now()) {
  const hours = Math.max(0, now - (life.updatedAt ?? now)) / 3_600_000;
  const happiness = Math.max(HAPPINESS_FLOOR, Math.min(life.happiness, life.happiness - hours * HAPPINESS_DECAY_PER_HOUR));
  return { ...life, happiness, updatedAt: now };
}

// Returns { life, rewarded, leveledUp }.
function reward(current, kind, now = Date.now()) {
  const rule = REWARDS[kind];
  const life = decay(current, now);
  if (!rule) return { life, rewarded: false, leveledUp: false };
  // a feeding time in the future means the clock went back: don't let it block feeding until the clock catches up
  const fedAt = life.lastFedAt;
  if (rule.cooldownMs && fedAt && fedAt <= now && now - fedAt < rule.cooldownMs) {
    return { life, rewarded: false, leveledUp: false };
  }

  let xp = rule.xp;
  let playXp = life.playXp || { date: null, amount: 0 };
  if (rule.play) {
    const today = localDateKey(new Date(now));
    if (playXp.date !== today) playXp = { date: today, amount: 0 };
    xp = Math.max(0, Math.min(xp, DAILY_PLAY_XP_CAP - playXp.amount));
    playXp = { ...playXp, amount: playXp.amount + xp };
  }

  const next = {
    ...life,
    happiness: Math.min(100, life.happiness + rule.happiness),
    xp: life.xp + xp,
    playXp,
    ...(kind === 'fed' ? { lastFedAt: now } : {}),
  };
  next.level = levelForXp(next.xp);
  return { life: next, rewarded: true, leveledUp: next.level > life.level };
}

module.exports = {
  LEVEL_XP, newLife, levelForXp, sanitizeLife, needsDecay, decay, reward,
};
