// User settings live in Electron's userData folder (never in the repo).
const fs = require('node:fs');
const path = require('node:path');

const DEFAULTS = {
  pet: 'celestial-fox',
  pollMinutes: 2, // while Claude is running
  idlePollMinutes: 10, // while Claude is closed
  warnAtPercent: 85,
  loungeAfterMinutes: 3, // no pet interaction for this long -> lie down
  loungeOnTaskbar: true, // drift down onto the taskbar before lying down
  sleepWhenAwayMinutes: 10, // no keyboard/mouse input on the computer for this long -> sleep
  fidgets: true, // occasional idle animations, if the pet has them
  hideHotkey: 'CommandOrControl+Alt+P',
  launchAtStartup: false,
  claudeProcessNames: ['claude.exe', 'claude'],
  credentialsPath: null, // null = ~/.claude/.credentials.json
  scopedLimit: null, // which per-model weekly limit drives the third orb; null = first one reported
  lightBackdrop: 'auto', // true | false | 'auto' (follow the Windows light/dark setting)
  petPosition: null,
};

function configPath(dir) {
  return path.join(dir, 'config.json');
}

function loadConfig(dir) {
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(configPath(dir), 'utf8')) };
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn('[config] could not read config.json, using defaults:', err.message);
      return { ...DEFAULTS };
    }
    const config = { ...DEFAULTS };
    saveConfig(dir, config); // first run: write defaults so users can find and edit them
    return config;
  }
}

function saveConfig(dir, config) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(configPath(dir), JSON.stringify(config, null, 2));
}

module.exports = { DEFAULTS, loadConfig, saveConfig, configPath };
