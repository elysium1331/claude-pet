// The pet's happiness and experience. Pure functions over a plain object so it can be unit tested and saved as JSON.
const { localDateKey } = require('./behavior');

const LEVEL_XP = [0, 30, 120, 300]; // xp needed for growth levels 0–3
const HAPPINESS_START = 60;
const HAPPINESS_FLOOR = 20;
const HAPPINESS_DECAY_PER_HOUR = 2;
const DAILY_PLAY_XP_CAP = 30;

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
  if (rule.cooldownMs && life.lastFedAt && now - life.lastFedAt < rule.cooldownMs) {
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

module.exports = { LEVEL_XP, newLife, levelForXp, decay, reward };
