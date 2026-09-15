const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const {
  app, BrowserWindow, Tray, Menu, nativeImage, nativeTheme, globalShortcut, ipcMain, protocol, net, screen, shell,
  powerMonitor, dialog,
} = require('electron');
const {
  DEFAULTS, loadConfig, saveConfigChanges, configPath, loginItemAtLaunch,
} = require('./config');
const {
  loadPetPack, loadPetOrFallback, petDrawFailurePlan, goodbyePlan,
} = require('./pet-pack');
const { openLifeStore } = require('./pet-life-store');
const { logStrayErrors, startGuarded, guarded: guardWith } = require('./error-guard');
const { resolveServedFile } = require('./served-files');
const { defaultCredentialsPath } = require('./claude-auth');
const { UsageService } = require('./usage-service');
const { isClaudeRunning } = require('./claude-process');
const {
  levelFor, colorForPercent, choosePetState, formatReset, formatCountdown, formatAgo, pickScoped, usageAsOf,
} = require('./usage-parse');
const {
  clampPet, panelPlacement, chooseFacing, mirrorInsets, scaledPetSize, resizeAnchored, positionChanged,
} = require('./placement');
const {
  restingPose, insetsForState, wakeReaction, fidgetsFor, lookFromCursor, usageEvents, localDateKey, shouldGreet,
  isNightTime, resolveState, usageRose,
} = require('./behavior');
const { ClaudeActivity } = require('./claude-activity');
const { startHookServer } = require('./hook-server');
const hooksInstaller = require('./hooks-installer');
const { classifyClicks, StrokeDetector, edgeBump } = require('./gestures');
const petLife = require('./pet-life');
const {
  shouldStartRoam, planRoam, stepToward, roamDelayMs, roamPose: poseForRoam,
} = require('./roam');

const ROOT = path.join(__dirname, '..', '..'); // inside app.asar (read-only) in the installed build
const DEFAULT_PET = DEFAULTS.pet;
const POSITION_SAVE_DELAY_MS = 1000;
const LOG_MAX_BYTES = 512 * 1024;
const PET_SIZE = { width: 150, height: 160 }; // updated in place when the size setting changes
const SIZE_OPTIONS = [['Small', 0.8], ['Normal', 1], ['Large', 1.25], ['Extra large', 1.5]];
const PANEL_PAD = 14; // transparent room around the stats card for its shadow (matches panel.css)
const SNAP_PX = 28;
const USAGE_PAGE = 'https://claude.ai/settings/usage';
const CLAUDE_CHECK_MS = 15_000;
const TICK_MS = 1000;
const LOOK_MS = 50;
const VIEW_REFRESH_MS = 30_000;
const CLICK_GAP_MS = 280; // clicks closer together than this count as one burst
const CHASE_MS = 8000;
const CHASE_STEP_PX = 14;
const BONK_COOLDOWN_MS = 1500;
const ROAM_STEP_MS = 30;
const ROAM_OK_STATES = new Set(['idle', 'sitting', 'lounging']);

const args = parseArgs(process.argv);

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

if (args.snapshot) {
  // Snapshot runs use their own profile so they work while a normal copy of the pet is running.
  app.setPath('userData', path.join(app.getPath('temp'), 'claude-pet-snapshot'));
} else {
  // Same settings folder whether run from source or installed ("Claude Pet"), so nothing is lost when switching.
  app.setPath('userData', path.join(app.getPath('appData'), 'claude-pet'));
}
if (!args.snapshot && !app.requestSingleInstanceLock()) {
  app.quit();
}

logStrayErrors(process, logError);

let petWin = null;
let panelWin = null;
let tray = null;
let config = null;
let pet = null;
let usage = null;
let activity = null;
let claudeRunning = true;

let petPos = null; // top-left of the pet window
let grounded = false;
let facing = 1; // 1 = right, -1 = left
let drag = null;
let glide = null;
let chase = null;
let roam = null;
let nextRoamAt = 0;

let statsOpen = false;
let panelSize = { width: 212, height: 180 };
let statsTimers = [];

let petState = 'idle';
let lastInteraction = Date.now();
let lastInteractionReason = 'startup';
let lastClaudeEventAt = 0;
let lastClaudeEvent = null;
let lastUsageRiseAt = 0;
let nextFidgetAt = 0;
let lastViewPush = 0;
let lastLook = { x: 0, y: 0 };
let lastGoodUsage = null;
let quitting = false;

let appTimers = [];
let life = null;
let lifeStore = null;
let lifeSaveTimer = null;
let configWritable = true; // false when config.json couldn't be read: never save over it that session
let positionSaveTimer = null;
let hotkeyLabel = null; // the show/hide shortcut, when it was accepted
let petDrawFailed = false;
let lastLogged = { text: '', at: 0 };
let displayedGrowth = 0; // lags behind life.level until the level-up celebration plays
let lastNightMode = null;
let clickCount = 0;
let clickTimer = null;
let nextTrick = 0;
const rubDetector = new StrokeDetector({ minTravel: 6, reversals: 4, windowMs: 1200, cooldownMs: 4000 });
const shakeDetector = new StrokeDetector({ minTravel: 40, reversals: 5, windowMs: 1500 });

function parseArgs(argv) {
  const get = (name) => argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const startAt = get('start-at')?.split(',').map(Number);
  return {
    fakeUsage: get('fake-usage'), // path to a saved usage JSON, for screenshots/dev without network
    snapshot: get('snapshot'), // write PNGs of the pet (and panel) after load, then quit
    snapshotStats: argv.includes('--snapshot-stats'),
    snapshotDelay: Number(get('snapshot-delay')) || 6500, // ms after startup to take the snapshot
    reaction: get('reaction'), // fire a reaction shortly before the snapshot, e.g. 'yawn'
    claudeRunning: get('claude-running'), // 'true' | 'false' to override process detection
    petState: get('pet-state'), // force a pet state, e.g. 'lounging'
    debugHooks: argv.includes('--debug-hooks'), // log Claude Code hook events to the console
    growth: get('growth'), // force a growth tier for screenshots
    palette: get('palette'), // force a color theme for screenshots
    night: get('night'), // 'true' | 'false' to force night glow
    roamNow: argv.includes('--roam-now'), // start a free-roam trip right after launch
    roamAt: Number(get('roam-at')) || 0, // start a free-roam trip this many ms after launch
    scale: get('scale'), // override the pet size for screenshots
    liveUsage: argv.includes('--live-usage'), // let a snapshot run fetch real usage (otherwise it uses saved numbers)
    startAt: startAt?.length === 2 && startAt.every(Number.isFinite) ? { x: startAt[0], y: startAt[1] } : null,
  };
}

function userDataDir() {
  return app.getPath('userData');
}

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

function logPath() {
  return path.join(userDataDir(), 'claude-pet.log');
}

// Logs to the console and to claude-pet.log in the settings folder (a packaged app has no visible console).
function logError(context, err) {
  const text = `${context}: ${err?.stack || err}`;
  console.error(`[main] ${text}`);
  const now = Date.now();
  if (text === lastLogged.text && now - lastLogged.at < 60_000) return; // the same throw on every tick
  lastLogged = { text, at: now };
  try {
    const file = logPath();
    if (fs.existsSync(file) && fs.statSync(file).size > LOG_MAX_BYTES) fs.rmSync(file, { force: true });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${new Date(now).toISOString()} ${text}\n`);
  } catch {
    // logging must never throw
  }
}

function guarded(context, fn) {
  return guardWith(logError, context, fn);
}

// Not awaited, so the pet keeps running while it is open.
function showNotice(message, detail = '') {
  console.warn(`[notice] ${message} ${detail}`);
  if (args.snapshot) return;
  dialog.showMessageBox({ type: 'warning', title: 'Claude Pet', message, detail, buttons: ['OK'] }).catch(() => {});
}

// ---------- pets ----------

// Custom pets go in the settings folder, since the installed app's own files are read-only.
function userPetsDir() {
  return path.join(userDataDir(), 'pets');
}

function petRoots() {
  return [
    { dir: path.join(ROOT, 'pets'), urlBase: 'app://bundle/pets', builtIn: true },
    { dir: userPetsDir(), urlBase: 'app://bundle/user-pets', builtIn: false },
  ];
}

function serveAppFiles() {
  const mounts = [
    { prefix: 'src/renderer/', dir: path.join(ROOT, 'src', 'renderer') },
    { prefix: 'node_modules/@rive-app/webgl2/', dir: path.join(ROOT, 'node_modules', '@rive-app', 'webgl2') },
    { prefix: 'pets/', dir: path.join(ROOT, 'pets') },
    { prefix: 'user-pets/', dir: userPetsDir() },
  ];
  protocol.handle('app', (request) => {
    const file = resolveServedFile(new URL(request.url).pathname, mounts);
    if (!file) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(file).toString());
  });
}

// The pet file couldn't be drawn. A custom pet is swapped for the built-in one; if the built-in pet can't be drawn
// either (no WebGL2, for example), the invisible window stops catching clicks and usage stays in the tray.
function handlePetLoadFailure(message) {
  logError(`drawing the pet "${pet.folder}"`, message);
  const situation = { folder: pet.folder, fallback: DEFAULT_PET, alreadyFailed: petDrawFailed };
  let plan = petDrawFailurePlan(situation);
  if (plan === 'fallback') {
    const failed = pet.folder;
    try {
      pet = loadPetPack(DEFAULT_PET, petRoots().filter((root) => root.builtIn));
      showNotice(`The pet "${failed}" could not be drawn, so the built-in pet is shown instead.`, message);
      tray?.setImage(trayIcon());
      refreshTrayMenu();
      petWin.webContents.reload();
      settlePet();
      return;
    } catch (err) {
      logError('loading the built-in pet', err);
      plan = petDrawFailurePlan({ ...situation, fallbackBroken: true });
    }
  }
  if (plan !== 'ignoreMouse') return;
  petDrawFailed = true;
  petWin.setIgnoreMouseEvents(true);
  showNotice(
    'Claude Pet could not draw the pet on this computer.',
    `Your usage is still available from the tray icon (hover it, or choose Show usage stats). Details: ${message}`,
  );
}

// ---------- happiness and experience ----------

function lifePath() {
  return path.join(userDataDir(), 'pet-life.json');
}

function loadLife(notices) {
  lifeStore = openLifeStore(lifePath());
  if (lifeStore.error) logError('reading pet-life.json', lifeStore.error);
  if (lifeStore.notice) notices.push(lifeStore.notice);
  return lifeStore.life;
}

function saveLife() {
  if (args.snapshot || !life || !lifeStore) return;
  try {
    lifeStore.save(life);
  } catch (err) {
    console.warn('[life] could not save:', err.message);
  }
}

function scheduleLifeSave() {
  if (args.snapshot) return;
  clearTimeout(lifeSaveTimer);
  lifeSaveTimer = setTimeout(saveLife, 2000);
}

function rewardPet(kind) {
  const result = petLife.reward(life, kind);
  life = result.life;
  scheduleLifeSave();
  pushView();
  if (result.leveledUp) {
    // after the reaction that earned it: grow and celebrate together
    setTimeout(() => {
      displayedGrowth = life.level;
      pushView();
      playEvent('levelUp');
    }, 2800);
  }
  return result.rewarded;
}

function nightModeOn(now = new Date()) {
  if (config.nightMode === 'auto') return isNightTime(now, config.nightStartHour, config.nightEndHour);
  return !!config.nightMode;
}

function setPetScale(scale) {
  const oldSize = { ...PET_SIZE };
  Object.assign(PET_SIZE, scaledPetSize(scale));
  persistConfig({ petScale: scale });
  closeStats();
  cancelGlide();
  setPetBounds(resizeAnchored(petPos, oldSize, PET_SIZE));
  settlePet();
  refreshTrayMenu();
}

function setTaskbarPose(pose) {
  setAppearance('taskbarPose', pose);
  tick();
}

// Updates settings in memory and saves only those keys, so edits made to config.json while the pet runs are kept.
function persistConfig(changes) {
  Object.assign(config, changes);
  if (args.snapshot || !configWritable) return;
  try {
    saveConfigChanges(userDataDir(), changes);
  } catch (err) {
    console.warn('[config] could not save settings:', err.message);
  }
}

function setAppearance(key, value) {
  persistConfig({ [key]: value });
  pushView();
  refreshTrayMenu();
}

// ---------- view model sent to both windows ----------

function displayState() {
  if (args.petState) return args.petState;
  if (chase) return 'chasing';
  if (roam?.plan) return roamPose();
  return petState;
}

function buildView() {
  const { status, message, fetchedAt } = usage.snapshot;
  const now = new Date();
  const u = usageAsOf(usage.snapshot.usage, fetchedAt, now);
  const scoped = pickScoped(u, config.scopedLimit);
  const meters = [u?.session, u?.weekly, scoped].filter(Boolean).map((m, i) => ({
    id: m.id,
    label: m.label,
    mark: i + 1, // matches the 1/2/3 dots on the pet's orbs
    percent: Math.round(m.percent),
    level: levelFor(m.percent),
    color: colorForPercent(m.percent),
    resetText: formatReset(m.resetsAt, now),
    countdown: formatCountdown(m.resetsAt, now),
    resetPassed: !!m.resetPassed,
  }));
  const orbs = { session: u?.session?.percent ?? 0, weekly: u?.weekly?.percent ?? 0, model: scoped?.percent ?? 0 };
  return {
    petState: resolveState(pet, displayState()),
    meters,
    orbs,
    orbColors: {
      session: colorForPercent(orbs.session),
      weekly: colorForPercent(orbs.weekly),
      model: colorForPercent(orbs.model),
    },
    flipped: isFlipped(),
    facing,
    happiness: Math.round(life.happiness),
    growth: Math.min(pet.maxGrowth ?? 0, args.growth !== undefined ? Number(args.growth) : displayedGrowth),
    palette: Math.min(Math.max(0, (pet.palettes?.length || 1) - 1), Math.max(0, Number(args.palette ?? config.palette) || 0)),
    nightMode: args.night !== undefined ? args.night === 'true' : nightModeOn(now),
    status,
    message,
    updatedAgo: formatAgo(fetchedAt, now),
    claudeRunning,
    lightBackdrop: config.lightBackdrop === 'auto' ? !nativeTheme.shouldUseDarkColors : !!config.lightBackdrop,
    ambientMotion: config.ambientMotion !== false,
  };
}

function pushView() {
  if (!usage || !life) return;
  lastViewPush = Date.now();
  const view = buildView();
  for (const win of [petWin, panelWin]) {
    if (win && !win.isDestroyed()) win.webContents.send('app:view', view);
  }
  if (tray) {
    const summary = view.meters.map((m) => `${m.label} ${m.percent}%`).join(' · ');
    tray.setToolTip(`Claude Pet${summary ? ` — ${summary}` : ''}`.slice(0, 127));
  }
}

function sendReaction(name) {
  if (name && petWin && !petWin.isDestroyed()) petWin.webContents.send('pet:reaction', name);
}

function sendHeld(held, lean = 0) {
  if (petWin && !petWin.isDestroyed()) petWin.webContents.send('pet:held', { held, lean });
}

// A meaningful reaction (not a random fidget): play it if the pet is awake and visible, and hold off fidgets.
function playEvent(eventName) {
  let trigger = pet.reactions?.[eventName];
  if (Array.isArray(trigger)) trigger = trigger[nextTrick++ % trigger.length];
  if (!trigger || !petWin?.isVisible() || displayState() === 'sleeping') return false;
  sendReaction(trigger);
  nextFidgetAt = Math.max(nextFidgetAt, Date.now() + 10_000);
  return true;
}

function handleUsageUpdate() {
  if (usage.snapshot.status === 'ok') {
    if (usageRose(lastGoodUsage, usage.snapshot.usage)) lastUsageRiseAt = Date.now(); // Claude used somewhere: perk up
    usageEvents(lastGoodUsage, usage.snapshot.usage).forEach(playEvent);
    lastGoodUsage = usage.snapshot.usage;
  }
  tick();
}

function handleHookEvent(event, payload) {
  const reactions = activity.handle(event, payload);
  if (args.debugHooks) console.log('[hooks]', event, payload.session_id || '', '->', reactions.join(',') || '-', '| now', activity.summary() || 'quiet');
  // Claude activity shows working poses but doesn't count as touching the pet; it only delays lounging briefly.
  lastClaudeEventAt = Date.now();
  lastClaudeEvent = event;
  reactions.forEach(playEvent);
  if (reactions.includes('taskDone')) rewardPet('taskDone');
  tick();
}

function hooksStatus() {
  try {
    return hooksInstaller.hooksInstalled() ? 'installed' : 'missing';
  } catch {
    return 'unreadable';
  }
}

async function toggleHooks() {
  const installed = hooksStatus() === 'installed';
  const { response } = await dialog.showMessageBox({
    type: 'question',
    buttons: [installed ? 'Remove hooks' : 'Install hooks', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    title: 'Claude Pet',
    message: installed ? 'Remove Claude Pet hooks from Claude Code?' : 'Connect Claude Pet to Claude Code?',
    detail: installed
      ? 'Claude Code will stop telling the pet when it is working, needs permission or finishes. Your other hooks are left alone.'
      : `Adds hooks to ${hooksInstaller.settingsPath()} so Claude Code tells the pet when it is working, needs permission, finishes or hits an error. `
        + 'Events are sent only to this computer (127.0.0.1). A backup of the file is saved first, and your other settings and hooks are left alone.',
  });
  if (response !== 0) return;
  try {
    const result = installed ? hooksInstaller.uninstallHooks() : hooksInstaller.installHooks(config.hooksPort);
    if (result.backupPath) console.log('[hooks] settings backup saved to', result.backupPath);
  } catch (err) {
    dialog.showErrorBox('Claude Pet', `Could not update Claude Code settings: ${err.message}`);
  }
  refreshTrayMenu();
}

function greetIfFirstToday() {
  if (!shouldGreet(config.lastGreetDate)) return;
  if (!playEvent('greet')) return;
  persistConfig({ lastGreetDate: localDateKey() });
}

// ---------- pet behavior ----------

function markInteraction(reason = 'you interacted with the pet') {
  lastInteraction = Date.now();
  lastInteractionReason = reason;
  if (petState === 'lounging') tick();
}

// What the pet thinks is going on, for troubleshooting: GET http://127.0.0.1:<hooksPort>/claude-pet/status
function statusSnapshot() {
  const now = Date.now();
  return {
    petState,
    shownPose: displayState(),
    claudeActivity: activity?.summary() ?? null,
    claudeSessions: [...(activity?.sessions ?? new Map())].map(([id, s]) => ({
      session: id.slice(0, 8),
      status: s.status,
      secondsSinceLastEvent: Math.round((now - s.lastEventAt) / 1000),
    })),
    secondsSincePetWasDisturbed: Math.round((now - lastInteraction) / 1000),
    lastDisturbedBy: lastInteractionReason,
    secondsSinceClaudeEvent: lastClaudeEventAt ? Math.round((now - lastClaudeEventAt) / 1000) : null,
    lastClaudeEvent,
    secondsSinceUsageRose: lastUsageRiseAt ? Math.round((now - lastUsageRiseAt) / 1000) : null,
    loungesAfterSeconds: config.loungeAfterMinutes * 60,
    secondsSinceKeyboardOrMouse: powerMonitor.getSystemIdleTime(),
    claudeAppRunning: claudeRunning,
    usageStatus: usage?.snapshot.status,
    grounded,
    statsOpen,
    roaming: !!roam,
    visible: windowAlive(petWin) && petWin.isVisible(),
  };
}

function computePetState(now = Date.now()) {
  return choosePetState({
    claudeRunning,
    usage: usageAsOf(usage.snapshot.usage, usage.snapshot.fetchedAt, new Date(now)),
    warnAt: config.warnAtPercent,
    needsLogin: usage.snapshot.status === 'needs-login',
    userAwayMs: powerMonitor.getSystemIdleTime() * 1000,
    petIdleMs: statsOpen || drag || chase ? 0 : now - lastInteraction,
    loungeAfterMs: config.loungeAfterMinutes * 60_000,
    awayAfterMs: config.sleepWhenAwayMinutes * 60_000,
    activity: activity.summary(),
    claudeQuietMs: now - lastClaudeEventAt,
    usageQuietMs: now - lastUsageRiseAt,
  });
}

function maybeFidget(now) {
  if (now < nextFidgetAt) return;
  const options = config.fidgets && !statsOpen && !drag && !chase && !roam && petWin.isVisible() ? fidgetsFor(pet, displayState()) : [];
  if (!options.length) {
    nextFidgetAt = now + 5000;
    return;
  }
  const pick = options[Math.floor(Math.random() * options.length)];
  sendReaction(pick.trigger);
  nextFidgetAt = now + pick.ms + randomBetween(25_000, 70_000);
}

function tick() {
  if (!usage || !windowAlive(petWin) || !life || quitting) return;
  const now = Date.now();

  const night = nightModeOn();
  if (night !== lastNightMode) {
    lastNightMode = night;
    pushView();
  }

  if (petLife.needsDecay(life, now)) {
    const before = Math.round(life.happiness);
    life = petLife.decay(life, now);
    scheduleLifeSave();
    if (Math.round(life.happiness) !== before) pushView();
  }

  const next = restingPose(pet, computePetState(now), grounded, config.taskbarPose);
  if (next !== petState) {
    sendReaction(wakeReaction(pet, petState, next));
    petState = next;
    pushView();
    if (!chase && !drag && !roam) {
      // Poses occupy different parts of the pet box, so settle into the new pose's bounds.
      if (displayState() === 'lounging' && config.loungeOnTaskbar) glideToGround();
      else settlePet();
    }
  } else if (now - lastViewPush > VIEW_REFRESH_MS) {
    pushView(); // keeps reset countdowns fresh
  }

  if (roam && !ROAM_OK_STATES.has(petState)) {
    cancelRoam({ returnHome: true }); // Claude needs attention, a limit was hit, etc.
  } else if (!roam && shouldStartRoam({
    mode: config.roam,
    now,
    nextRoamAt,
    state: petState,
    busy: statsOpen || !!drag || !!chase || !petWin.isVisible(),
    petIdleMs: now - lastInteraction,
  })) {
    startRoam();
  }
  maybeFidget(now);
}

// ---------- playing ----------

function registerClick() {
  markInteraction();
  if (roam) {
    cancelRoam({ returnHome: true }); // clicking a roaming pet calls it home
    return;
  }
  clickCount += 1;
  clearTimeout(clickTimer);
  clickTimer = setTimeout(() => {
    const gesture = classifyClicks(clickCount);
    clickCount = 0;
    if (gesture === 'stats') {
      if (statsOpen) closeStats();
      else openStats();
    } else if (gesture === 'trick') {
      closeStats();
      doTrick();
    } else if (gesture === 'tickle') {
      closeStats();
      if (playEvent('tickled')) rewardPet('tickled');
    }
  }, CLICK_GAP_MS);
}

function doTrick() {
  if (playEvent('tricks')) rewardPet('trick');
}

function feedPet() {
  markInteraction();
  if (playEvent('eat')) rewardPet('fed');
}

function startChase() {
  if (chase || !petWin.isVisible() || displayState() === 'sleeping') return;
  if (roam) cancelRoam({ returnHome: false });
  closeStats();
  cancelGlide();
  markInteraction();
  chase = { until: Date.now() + CHASE_MS, timer: null };
  pushView();
  chase.timer = setInterval(guarded('chase', chaseStep), 30);
}

function chaseStep() {
  if (quitting || !windowAlive(petWin)) return;
  const cursor = screen.getCursorScreenPoint();
  const center = petCenter();
  const dx = cursor.x - center.x;
  const dy = cursor.y - center.y;
  const distance = Math.hypot(dx, dy);

  if (distance < 30) {
    endChase(true);
    return;
  }
  if (Date.now() > chase.until) {
    endChase(false);
    return;
  }
  const nextFacing = dx >= 0 ? 1 : -1;
  if (Math.abs(dx) > 60 && nextFacing !== facing) { // a turn takes ~350ms, so don't flip on tiny overshoots
    facing = nextFacing;
    pushView();
  }
  const step = Math.min(CHASE_STEP_PX, distance);
  movePet({ x: Math.round(petPos.x + (dx / distance) * step), y: Math.round(petPos.y + (dy / distance) * step) }, workAreaAt(cursor));
}

function endChase(caught) {
  if (!chase) return;
  clearInterval(chase.timer);
  chase = null;
  markInteraction();
  if (caught) playEvent('catch');
  rewardPet('played');
  pushView();
  updateFacing();
  settlePet();
}

// ---------- free roam ----------

function scheduleNextRoam(now = Date.now()) {
  nextRoamAt = now + roamDelayMs(config.roamMinMinutes, config.roamMaxMinutes);
}

function roamPose() {
  return poseForRoam(roam.plan.kind, roam.pauseUntil > 0, config);
}

function startRoam() {
  if (roam || chase || drag || !windowAlive(petWin) || !petWin.isVisible()) return;
  closeStats();
  cancelGlide();
  const workArea = workAreaAt(petCenter());
  // Plan with the travel pose's bounds, so e.g. a floating tail doesn't dip into the taskbar.
  const travelPose = resolveState(pet, poseForRoam('stroll', false, config));
  const options = { petSize: PET_SIZE, insets: insetsForState(pet, travelPose, facing), workArea, snapPx: SNAP_PX };
  const clamp = (p) => {
    const placed = clampPet(p, { ...options, snapPx: 0 });
    return { x: placed.x, y: placed.y };
  };
  const plan = planRoam({
    home: { ...petPos },
    mode: config.roam === 'off' ? 'taskbar' : config.roam,
    workArea,
    petSize: PET_SIZE,
    clamp,
    groundY: clampPet({ x: petPos.x, y: Number.MAX_SAFE_INTEGER }, options).y,
    cursor: screen.getCursorScreenPoint(),
  });
  const wasResting = petState === 'lounging';
  // A resting pet gets up (wake-up hop) before it starts walking.
  const startAt = Date.now() + (wasResting && pet.reactions?.wake ? 1600 : 0);
  roam = { plan, home: { ...petPos }, index: 0, pauseUntil: 0, waitingSince: 0, timer: null, startAt };
  if (wasResting) sendReaction(pet.reactions?.wake);
  pushView();
  roam.timer = setInterval(guarded('roam', roamStep), ROAM_STEP_MS);
}

function roamStep() {
  if (quitting || !roam || !windowAlive(petWin)) return;
  const now = Date.now();
  if (now < roam.startAt) return;
  if (roam.pauseUntil) {
    if (now < roam.pauseUntil) return;
    roam.pauseUntil = 0;
    advanceRoam();
    return;
  }

  // If the cursor is right where the pet is, wait politely (but not forever).
  const cursor = screen.getCursorScreenPoint();
  const center = petCenter();
  if (Math.hypot(cursor.x - center.x, cursor.y - center.y) < 110) {
    roam.waitingSince = roam.waitingSince || now;
    if (now - roam.waitingSince < 4000) return;
  } else {
    roam.waitingSince = 0;
  }

  const waypoint = roam.plan.waypoints[roam.index];
  const dx = waypoint.x - petPos.x;
  if (Math.abs(dx) > 8 && Math.sign(dx) !== facing) {
    facing = Math.sign(dx);
    pushView();
  }
  const next = stepToward(petPos, waypoint, roam.plan.kind === 'stroll' ? 3 : 5);
  setPetBounds(next);
  if (!next.arrived) return;

  if (waypoint.pauseMs > 0) {
    roam.pauseUntil = now + waypoint.pauseMs;
    pushView();
    playEvent('roamPause');
  } else {
    advanceRoam();
  }
}

function advanceRoam() {
  roam.index += 1;
  if (roam.index >= roam.plan.waypoints.length) finishRoam();
  else pushView();
}

function finishRoam() {
  clearInterval(roam.timer);
  roam = null;
  scheduleNextRoam();
  pushView();
  playEvent('roamHome');
  updateFacing();
}

// Stops a trip; returns where home was.
function cancelRoam({ returnHome }) {
  if (!roam) return null;
  clearInterval(roam.timer);
  const { home } = roam;
  roam = null;
  scheduleNextRoam();
  pushView();
  if (returnHome) glideTo(home, 500, updateFacing);
  return home;
}

function setRoamMode(mode) {
  if (mode === 'off') cancelRoam({ returnHome: true });
  setAppearance('roam', mode);
}

// ---------- pet window placement ----------

function petCenter(pos = petPos) {
  return { x: Math.round(pos.x + PET_SIZE.width / 2), y: Math.round(pos.y + PET_SIZE.height / 2) };
}

function workAreaAt(point) {
  return screen.getDisplayNearestPoint(point).workArea;
}

// Pets with a facing control turn themselves; older pets are mirrored instead.
function turnsByItself() {
  return !!pet.binding?.facingProperty;
}

function isFlipped() {
  return !turnsByItself() && facing !== (pet.artFacing || 1);
}

function currentInsets() {
  const insets = insetsForState(pet, drag ? 'held' : resolveState(pet, displayState()), facing);
  return turnsByItself() ? insets : mirrorInsets(insets, isFlipped());
}

function placementOptions(workArea) {
  return { petSize: PET_SIZE, insets: currentInsets(), workArea, snapPx: SNAP_PX };
}

function setPetBounds(pos) {
  if (!windowAlive(petWin)) return;
  petPos = { x: pos.x, y: pos.y };
  petWin.setBounds({ ...petPos, ...PET_SIZE }); // setBounds keeps transparent windows from growing on scaled displays
  if (statsOpen) placePanel();
}

function movePet(pos, workArea = workAreaAt(petCenter(pos))) {
  const placed = clampPet(pos, placementOptions(workArea));
  grounded = placed.grounded;
  setPetBounds(placed);
  return placed;
}

// Runs after every settle, which Claude Code activity triggers often: write only real moves, at most once a second.
function savePetPosition() {
  if (args.snapshot || !positionChanged(config.petPosition, petPos)) return;
  config.petPosition = { ...petPos };
  clearTimeout(positionSaveTimer);
  positionSaveTimer = setTimeout(flushPetPosition, POSITION_SAVE_DELAY_MS);
}

function flushPetPosition() {
  if (!positionSaveTimer) return;
  clearTimeout(positionSaveTimer);
  positionSaveTimer = null;
  persistConfig({ petPosition: config.petPosition });
}

function initialPetPosition() {
  const start = args.startAt || config.petPosition;
  if (start && Number.isFinite(start.x) && Number.isFinite(start.y)) return start;
  const { workArea } = screen.getPrimaryDisplay();
  return { x: workArea.x + 24, y: workArea.y + workArea.height }; // clamping drops this onto the taskbar
}

// Turn toward the middle of the screen after the pet settles somewhere new.
function updateFacing() {
  const center = petCenter();
  const next = chooseFacing({ centerX: center.x, workArea: workAreaAt(center), current: facing });
  if (next === facing) return;
  facing = next;
  pushView();
  settlePet(); // body insets mirror with the art
}

function cancelGlide() {
  clearInterval(glide);
  glide = null;
}

function glideTo(target, duration, onDone) {
  cancelGlide();
  const from = { ...petPos };
  if (from.x === target.x && from.y === target.y) {
    onDone?.();
    return;
  }
  const started = Date.now();
  glide = setInterval(guarded('glide', () => {
    const t = Math.min(1, (Date.now() - started) / duration);
    const eased = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
    setPetBounds({
      x: Math.round(from.x + (target.x - from.x) * eased),
      y: Math.round(from.y + (target.y - from.y) * eased),
    });
    if (t === 1) {
      cancelGlide();
      onDone?.();
    }
  }), 16);
}

// Slide (briefly) into the current pose's on-screen bounds.
function settlePet() {
  if (drag || chase) return;
  const placed = clampPet(petPos, placementOptions(workAreaAt(petCenter())));
  grounded = placed.grounded;
  glideTo(placed, 260, savePetPosition);
}

function glideToGround() {
  if (drag || chase) return;
  const target = clampPet({ x: petPos.x, y: Number.MAX_SAFE_INTEGER }, placementOptions(workAreaAt(petCenter())));
  const distance = Math.hypot(target.x - petPos.x, target.y - petPos.y);
  closeStats();
  glideTo(target, Math.min(2200, Math.max(300, distance * 2.2)), () => {
    grounded = true;
    updateFacing();
    savePetPosition();
  });
}

// ---------- windows ----------

function baseWindowOptions() {
  return {
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  };
}

function createPetWindow() {
  const start = initialPetPosition();
  const placed = clampPet(start, placementOptions(workAreaAt(petCenter(start))));
  petPos = { x: placed.x, y: placed.y };
  grounded = placed.grounded;

  petWin = new BrowserWindow({ ...baseWindowOptions(), ...petPos, ...PET_SIZE });
  petWin.setAlwaysOnTop(true, 'floating');
  petWin.once('ready-to-show', () => {
    petWin.showInactive();
    setTimeout(greetIfFirstToday, 2500); // after the appear sparkle
  });
  petWin.on('blur', closeStats); // clicking anywhere else closes the stats
  petWin.webContents.on('did-finish-load', pushView);
  petWin.loadURL('app://bundle/src/renderer/pet.html');
}

function createPanelWindow() {
  panelWin = new BrowserWindow({
    ...baseWindowOptions(),
    focusable: false, // clicking the panel must not steal focus from the pet (which would close it)
    width: panelSize.width + PANEL_PAD * 2,
    height: panelSize.height + PANEL_PAD * 2,
  });
  panelWin.setAlwaysOnTop(true, 'floating');
  panelWin.webContents.on('did-finish-load', pushView);
  panelWin.loadURL('app://bundle/src/renderer/panel.html');
}

function placePanel() {
  const size = { width: panelSize.width + PANEL_PAD * 2, height: panelSize.height + PANEL_PAD * 2 };
  const placed = panelPlacement({
    petPos,
    petSize: PET_SIZE,
    insets: currentInsets(),
    panelSize: size,
    workArea: workAreaAt(petCenter()),
    gap: 2 - PANEL_PAD,
    margin: 8 - PANEL_PAD,
  });
  panelWin.setBounds({ x: placed.x, y: placed.y, ...size });
  return placed.side;
}

function clearStatsTimers() {
  statsTimers.forEach(clearTimeout);
  statsTimers = [];
}

// Opening: the orbs fly together and merge first, then the panel grows out of that bubble.
function openStats() {
  if (statsOpen || !petWin.isVisible() || chase) return;
  statsOpen = true;
  cancelGlide();
  markInteraction();
  clearStatsTimers();
  const side = placePanel();
  petWin.webContents.send('pet:stats', { open: true, side });
  statsTimers.push(setTimeout(() => {
    if (!statsOpen) return;
    placePanel();
    panelWin.showInactive();
    panelWin.webContents.send('panel:open', side);
  }, pet.timings.statsMergeMs * 0.6));
}

// Closing: the panel shrinks back into the bubble, then the bubble splits into orbs again.
function closeStats() {
  if (!statsOpen) return;
  statsOpen = false;
  lastInteraction = Date.now();
  lastInteractionReason = 'stats panel closed';
  clearStatsTimers();
  panelWin.webContents.send('panel:close');
  statsTimers.push(setTimeout(() => {
    if (statsOpen) return;
    panelWin.hide();
    petWin.webContents.send('pet:stats', { open: false });
  }, 240));
}

function showStatsFromMenu() {
  if (!petWin.isVisible()) showPet();
  petWin.focus(); // so clicking elsewhere closes it again
  openStats();
}

function showPet() {
  petWin.showInactive();
  sendReaction(pet.reactions?.appear);
  refreshTrayMenu();
}

function hidePet() {
  closeStats();
  if (chase) endChase(false);
  const home = cancelRoam({ returnHome: false });
  if (home) setPetBounds(home); // reappear at home, not mid-trip
  sendReaction(pet.reactions?.disappear);
  setTimeout(() => {
    petWin.hide();
    refreshTrayMenu();
  }, pet.reactions?.disappear ? pet.timings.disappearMs : 0);
}

function toggleVisible() {
  if (!petWin) return;
  if (petWin.isVisible()) hidePet();
  else showPet();
}

// Wave goodbye, fade out, then quit.
function quitWithGoodbye() {
  if (quitting) {
    app.quit(); // asked again while it waves: don't make them wait
    return;
  }
  closeStats();
  const waved = playEvent('goodbye');
  quitting = true;
  const fades = !!(petWin?.isVisible() && pet.reactions?.disappear);
  const plan = goodbyePlan(pet.timings, { waved, fades });
  setTimeout(() => {
    if (fades) sendReaction(pet.reactions.disappear);
    setTimeout(() => app.quit(), plan.fadeMs);
  }, plan.waveMs);
  setTimeout(() => app.quit(), plan.fallbackMs);
}

function windowAlive(win) {
  return !!win && !win.isDestroyed();
}

// Stop every timer before windows are destroyed, so nothing touches a closed window during quit.
function stopTimers() {
  quitting = true;
  appTimers.forEach(clearInterval);
  appTimers = [];
  clearTimeout(clickTimer);
  clearStatsTimers();
  cancelGlide();
  if (chase) clearInterval(chase.timer);
  chase = null;
  if (roam) clearInterval(roam.timer);
  roam = null;
  usage?.stop();
}

// Eyes follow the mouse.
function trackCursor() {
  if (quitting || !windowAlive(petWin) || !petWin.isVisible() || drag || chase || (roam && !roam.pauseUntil)) return;
  const next = lookFromCursor({ cursor: screen.getCursorScreenPoint(), center: petCenter(), flipped: isFlipped() });
  if (Math.abs(next.x - lastLook.x) < 0.02 && Math.abs(next.y - lastLook.y) < 0.02) return;
  lastLook = next;
  petWin.webContents.send('pet:look', next);
}

// ---------- tray ----------

function trayIcon() {
  const image = nativeImage.createFromPath(path.join(pet.dir, pet.trayIcon || 'preview-dark.png'));
  if (image.isEmpty()) return image;
  const { width, height } = image.getSize();
  const side = Math.min(width, height);
  return image
    .crop({ x: Math.floor((width - side) / 2), y: Math.floor((height - side) / 2), width: side, height: side })
    .resize({ width: 32, height: 32, quality: 'best' });
}

function lifeSummary() {
  const next = petLife.LEVEL_XP[life.level + 1];
  const progress = next ? `${life.xp}/${next} XP` : `${life.xp} XP, max level`;
  return `Happiness ${Math.round(life.happiness)} · Level ${life.level} (${progress})`;
}

function buildMenu() {
  const hooks = hooksStatus();
  const awake = petWin?.isVisible() && displayState() !== 'sleeping';
  return Menu.buildFromTemplate([
    { label: 'Show usage stats', click: showStatsFromMenu },
    {
      label: 'Play',
      submenu: [
        { label: lifeSummary(), enabled: false },
        { type: 'separator' },
        { label: 'Feed a spark', enabled: awake, click: feedPet },
        { label: 'Chase my cursor', enabled: awake, click: startChase },
        { label: 'Do a trick', enabled: awake, click: doTrick },
        { label: 'Go for a stroll now', enabled: awake && !roam, click: startRoam },
        { type: 'separator' },
        { label: 'Free roam: off', type: 'radio', checked: config.roam === 'off', click: () => setRoamMode('off') },
        { label: 'Free roam: along the taskbar', type: 'radio', checked: config.roam === 'taskbar', click: () => setRoamMode('taskbar') },
        { label: 'Free roam: anywhere on screen', type: 'radio', checked: config.roam === 'screen', click: () => setRoamMode('screen') },
        { type: 'separator' },
        { label: 'Stroll: float (normal size)', type: 'radio', checked: config.strollPose !== 'walk', click: () => setAppearance('strollPose', 'float') },
        { label: 'Stroll: walk (compact)', type: 'radio', checked: config.strollPose === 'walk', click: () => setAppearance('strollPose', 'walk') },
      ],
    },
    {
      label: 'Appearance',
      submenu: [
        {
          label: 'Size',
          submenu: SIZE_OPTIONS.map(([label, scale]) => ({
            label, type: 'radio', checked: Number(config.petScale) === scale, click: () => setPetScale(scale),
          })),
        },
        {
          label: 'On the taskbar',
          submenu: [
            { label: 'Float (normal size)', type: 'radio', checked: config.taskbarPose !== 'sit', click: () => setTaskbarPose('float') },
            { label: 'Sit', type: 'radio', checked: config.taskbarPose === 'sit', click: () => setTaskbarPose('sit') },
          ],
        },
        { label: 'Ear and tail twitches', type: 'checkbox', checked: config.ambientMotion !== false, click: (item) => setAppearance('ambientMotion', item.checked) },
        { type: 'separator' },
        ...(pet.palettes || []).map((name, i) => ({
          label: name, type: 'radio', checked: Number(config.palette) === i, click: () => setAppearance('palette', i),
        })),
        ...(pet.palettes?.length ? [{ type: 'separator' }] : []),
        { label: 'Night glow: automatic', type: 'radio', checked: config.nightMode === 'auto', click: () => setAppearance('nightMode', 'auto') },
        { label: 'Night glow: always', type: 'radio', checked: config.nightMode === true, click: () => setAppearance('nightMode', true) },
        { label: 'Night glow: never', type: 'radio', checked: config.nightMode === false, click: () => setAppearance('nightMode', false) },
      ],
    },
    { label: petWin?.isVisible() ? 'Hide pet' : 'Show pet', accelerator: hotkeyLabel ?? undefined, registerAccelerator: false, click: toggleVisible },
    { label: 'Refresh usage now', click: () => usage.refreshNow() },
    { label: 'Open Claude usage page', click: () => shell.openExternal(USAGE_PAGE) },
    { type: 'separator' },
    { label: 'Launch at startup', type: 'checkbox', checked: !!config.launchAtStartup, click: (item) => setLaunchAtStartup(item.checked) },
    {
      label: hooks === 'installed' ? 'Disconnect from Claude Code…' : 'Connect to Claude Code…',
      enabled: hooks !== 'unreadable',
      click: toggleHooks,
    },
    { label: 'Open settings file', click: () => shell.openPath(configPath(userDataDir())) },
    { type: 'separator' },
    { label: 'Quit Claude Pet', click: quitWithGoodbye },
  ]);
}

function refreshTrayMenu() {
  tray?.setContextMenu(buildMenu());
}

function createTray() {
  tray = new Tray(trayIcon());
  tray.on('click', toggleVisible);
  tray.on('right-click', refreshTrayMenu); // keep the happiness/level line current
  refreshTrayMenu();
}

function loginItemSettings() {
  const devArgs = app.isPackaged ? {} : { path: process.execPath, args: [ROOT] };
  return { openAtLogin: !!config.launchAtStartup, ...devArgs };
}

// Applied at every launch, so setting launchAtStartup to false in config.json also removes the startup entry.
function syncLoginItem() {
  if (args.snapshot) return;
  try {
    app.setLoginItemSettings(loginItemSettings());
  } catch (err) {
    logError('updating the startup entry', err);
  }
}

function setLaunchAtStartup(enabled) {
  persistConfig({ launchAtStartup: enabled });
  syncLoginItem();
  refreshTrayMenu();
}

// Returns a notice when the configured shortcut isn't usable.
function registerHotkey() {
  if (args.snapshot || !config.hideHotkey) return null;
  try {
    if (!globalShortcut.register(config.hideHotkey, toggleVisible)) {
      console.warn(`[hotkey] could not register ${config.hideHotkey} (in use by another app?)`);
    }
    hotkeyLabel = config.hideHotkey;
    return null;
  } catch (err) {
    return `hideHotkey "${config.hideHotkey}" is not a shortcut Claude Pet understands, so there is no show/hide hotkey (${err.message}).`;
  }
}

// ---------- Claude app detection ----------

async function detectClaude() {
  if (args.claudeRunning) return args.claudeRunning === 'true';
  return isClaudeRunning(config.claudeProcessNames);
}

async function watchClaude() {
  if (quitting) return;
  try {
    const running = await detectClaude();
    if (!quitting && running !== claudeRunning) {
      claudeRunning = running;
      usage.setIntervalMinutes(running ? config.pollMinutes : config.idlePollMinutes);
      tick();
    }
  } catch (err) {
    logError('checking whether Claude is running', err);
  }
  if (!quitting) setTimeout(watchClaude, CLAUDE_CHECK_MS);
}

// ---------- IPC ----------

function registerIpc() {
  ipcMain.handle('pet:get-config', () => ({
    petUrl: pet.url,
    wasmUrl: 'app://bundle/node_modules/@rive-app/webgl2/rive.wasm',
    artboard: pet.artboard,
    stateMachine: pet.stateMachine,
    binding: pet.binding,
    states: pet.states,
    reactions: pet.reactions,
  }));

  ipcMain.on('pet:load-failed', (event, message) => {
    if (!windowAlive(petWin) || event.sender !== petWin.webContents) return;
    handlePetLoadFailure(String(message));
  });

  ipcMain.on('pet:drag-start', () => {
    cancelGlide();
    closeStats();
    if (chase) endChase(false);
    cancelRoam({ returnHome: false }); // wherever you drop it becomes home
    const cursor = screen.getCursorScreenPoint();
    drag = { dx: cursor.x - petPos.x, dy: cursor.y - petPos.y, lastX: cursor.x, lean: 0, lastBonkAt: 0 };
    shakeDetector.reset();
    markInteraction();
    sendHeld(true);
  });

  ipcMain.on('pet:drag-move', () => {
    if (!drag) return;
    const cursor = screen.getCursorScreenPoint();
    const now = Date.now();
    const desired = { x: cursor.x - drag.dx, y: cursor.y - drag.dy };
    const placed = movePet(desired, workAreaAt(cursor));

    // lean into the drag, and notice being pushed into an edge or shaken
    drag.lean = drag.lean * 0.7 + Math.max(-1, Math.min(1, (cursor.x - drag.lastX) / 25)) * 0.3;
    drag.lastX = cursor.x;
    sendHeld(true, Math.round(drag.lean * 100) / 100);
    if (edgeBump(desired, placed) && now - drag.lastBonkAt > BONK_COOLDOWN_MS) {
      drag.lastBonkAt = now;
      playEvent('bonk');
    }
    if (shakeDetector.add(cursor.x, now)) drag.dizzy = true;
  });

  ipcMain.on('pet:drag-end', () => {
    if (!drag) return;
    const { dizzy } = drag;
    drag = null;
    sendHeld(false);
    markInteraction();
    if (dizzy) playEvent('dizzy');
    else if (grounded) playEvent('land');
    updateFacing();
    settlePet();
    tick();
  });

  ipcMain.on('pet:click', registerClick);

  ipcMain.on('pet:hover-move', (_event, x) => {
    if (drag || chase || !Number.isFinite(x)) return;
    if (rubDetector.add(x, Date.now())) {
      markInteraction();
      if (playEvent('petted')) rewardPet('petted');
    }
  });

  ipcMain.on('pet:close-stats', closeStats);
  ipcMain.on('pet:context-menu', () => {
    closeStats();
    buildMenu().popup({ window: petWin });
  });

  ipcMain.on('panel:clicked', closeStats);
  ipcMain.on('panel:size', (_event, size) => {
    const width = Math.ceil(Number(size?.width));
    const height = Math.ceil(Number(size?.height));
    if (!(width > 0 && height > 0)) return;
    panelSize = { width, height };
    if (statsOpen) placePanel();
  });
}

// ---------- startup ----------

function scheduleSnapshot() {
  if (args.snapshotStats) setTimeout(openStats, 3500);
  if (args.reaction) setTimeout(() => sendReaction(args.reaction), 5000);
  if (args.roamNow) setTimeout(startRoam, 2500);
  if (args.roamAt) setTimeout(startRoam, args.roamAt);
  setTimeout(async () => {
    fs.writeFileSync(args.snapshot, (await petWin.webContents.capturePage()).toPNG());
    const work = workAreaAt(petCenter());
    if (roam) console.log('[snapshot] roaming', roam.plan.kind, `waypoint ${roam.index + 1}/${roam.plan.waypoints.length}`, 'plan', JSON.stringify(roam.plan.waypoints));
    console.log('[snapshot] state', displayState(), 'pet bounds', JSON.stringify(petWin.getBounds()), 'grounded', grounded, 'flipped', isFlipped(), 'workArea', JSON.stringify(work));
    if (args.snapshotStats) {
      const panelFile = args.snapshot.replace(/\.png$/i, '-panel.png');
      fs.writeFileSync(panelFile, (await panelWin.webContents.capturePage()).toPNG());
      console.log('[snapshot] panel bounds', JSON.stringify(panelWin.getBounds()), 'visible', panelWin.isVisible());
    }
    app.quit();
  }, args.snapshotDelay);
}

function configNotices(loaded) {
  const notices = [];
  if (loaded.error) {
    notices.push(`${loaded.error}. The pet is using default settings and won't change the file until you fix it and restart.`
      + `${loaded.brokenCopy ? ` A copy was saved as ${loaded.brokenCopy}.` : ''}`);
  }
  if (loaded.problems.length) {
    notices.push(`Some settings in config.json are not valid:\n${loaded.problems.map((p) => `• ${p.message}`).join('\n')}`);
  }
  return notices;
}

async function startApp() {
  const loaded = loadConfig(userDataDir());
  config = loaded.config;
  configWritable = loaded.writable;
  const notices = configNotices(loaded);

  const chosen = loadPetOrFallback(config.pet, { roots: petRoots(), fallback: DEFAULT_PET });
  pet = chosen.pet;
  if (chosen.notice) notices.push(chosen.notice);
  life = loadLife(notices);
  displayedGrowth = life.level;
  Object.assign(PET_SIZE, scaledPetSize(args.scale ?? config.petScale));
  serveAppFiles();
  registerIpc();

  // Process detection runs in the background (tasklist can be slow); until it answers, assume Claude is running.
  claudeRunning = args.claudeRunning ? args.claudeRunning === 'true' : true;
  usage = new UsageService({
    credentialsPath: config.credentialsPath || defaultCredentialsPath(),
    userAgent: `claude-pet/${app.getVersion()}`,
    cachePath: path.join(userDataDir(), 'usage-cache.json'),
    intervalMinutes: claudeRunning ? config.pollMinutes : config.idlePollMinutes,
    fakeUsagePath: args.fakeUsage,
    // snapshot runs reuse saved numbers so repeated test launches don't get rate limited by Anthropic
    offline: !!args.snapshot && !args.liveUsage,
    log: logError,
  });
  usage.on('update', guarded('usage update', handleUsageUpdate));

  activity = new ClaudeActivity({ celebrateAfterMs: config.celebrateAfterSeconds * 1000 });
  if (!args.snapshot || args.debugHooks) {
    try {
      startHookServer({ port: config.hooksPort, onEvent: guarded('Claude Code hook', handleHookEvent), onStatus: statusSnapshot });
    } catch (err) {
      logError('starting the hook listener', err);
    }
  }

  createPetWindow();
  updateFacing();
  createPanelWindow();
  createTray();
  const hotkeyNotice = registerHotkey();
  if (hotkeyNotice) notices.push(hotkeyNotice);
  if (loginItemAtLaunch(loaded) !== null) syncLoginItem(); // otherwise config holds defaults, not the user's choice

  // Taskbar moved, resolution changed or a monitor was unplugged: keep the pet on screen.
  const reclamp = guarded('keeping the pet on screen', () => {
    movePet(petPos);
    updateFacing();
  });
  screen.on('display-metrics-changed', reclamp);
  screen.on('display-removed', reclamp);

  // Numbers from before a sleep can be hours old: check again once the computer is back.
  const checkAfterSleep = guarded('checking usage after sleep', () => usage.resumed());
  powerMonitor.on('resume', checkAfterSleep);
  powerMonitor.on('unlock-screen', checkAfterSleep);

  nextFidgetAt = Date.now() + randomBetween(15_000, 30_000);
  scheduleNextRoam();
  usage.start();
  watchClaude();
  appTimers.push(setInterval(guarded('tick', tick), TICK_MS), setInterval(guarded('gaze', trackCursor), LOOK_MS));
  nativeTheme.on('updated', guarded('theme change', pushView));
  if (args.snapshot) scheduleSnapshot();
  if (notices.length) showNotice('Claude Pet started, but some things need your attention.', notices.join('\n\n'));
}

// Exits, so the single-instance lock is released (see startGuarded).
function failStartup(err) {
  logError('startup', err);
  if (!args.snapshot) {
    dialog.showErrorBox(
      'Claude Pet could not start',
      `${err?.message || err}\n\nIf you edited config.json or added a pet, check those changes and start Claude Pet again. `
        + `Details were saved to ${logPath()}.`,
    );
  }
  app.exit(1);
}

startGuarded(app.whenReady(), startApp, failStartup);

app.on('before-quit', stopTimers);
app.on('second-instance', () => windowAlive(petWin) && showPet());
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  flushPetPosition();
  clearTimeout(lifeSaveTimer);
  saveLife();
});
