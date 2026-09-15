const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const {
  app, BrowserWindow, Tray, Menu, nativeImage, nativeTheme, globalShortcut, ipcMain, protocol, net, screen, shell,
  powerMonitor, dialog, clipboard,
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
  ZERO_INSETS, clampPet, displayLimits, groundBelow, nearestDisplay, taskbarEdge, combinedInsets, panelPlacement,
  chooseFacing, mirrorInsets, scaledPetSize, resizeAnchored, positionChanged,
} = require('./placement');
const { pointerPlan, hitAreaBounds } = require('./click-through');
const {
  restingPose, insetsForState, wokeUp, wakeReaction, fidgetsFor, lookFromCursor, usageEvents, localDateKey,
  shouldGreet, isNightTime, resolveState, usageRose,
} = require('./behavior');
const { ClaudeActivity } = require('./claude-activity');
const { startHookServer } = require('./hook-server');
const hooksInstaller = require('./hooks-installer');
const { loadHookToken, renewHookToken, tokenPath } = require('./hooks-token');
const hooksPlan = require('./hooks-plan');
const { classifyClicks, StrokeDetector, edgeBump } = require('./gestures');
const petLife = require('./pet-life');
const {
  ROAM_STATES, shouldStartRoam, planRoam, stepToward, roamDelayMs, roamPose: poseForRoam,
} = require('./roam');

const ROOT = path.join(__dirname, '..', '..'); // inside app.asar (read-only) in the installed build
const DEFAULT_PET = DEFAULTS.pet;
const POSITION_SAVE_DELAY_MS = 1000;
const LOG_MAX_BYTES = 512 * 1024;
const PET_SIZE = { width: 150, height: 160 }; // updated in place when the size setting changes
const SIZE_OPTIONS = [['Small', 0.8], ['Normal', 1], ['Large', 1.25], ['Extra large', 1.5]];
const PANEL_PAD = 14; // transparent room around the stats card for its shadow (matches panel.css)
const SNAP_PX = 28;
const AUTO_HIDE_START_X = 240; // clear of the far-left taskbar button, short of the icons of a centered taskbar
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
const GREET_DELAY_MS = 2500; // lets the appear sparkle or the wake-up hop finish before waving hello

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
// The uninstaller's --remove-hooks run doesn't take the lock, so it works whether or not the pet is running.
if (!args.snapshot && !args.removeHooks && !app.requestSingleInstanceLock()) {
  app.quit();
}

logStrayErrors(process, logError);

let petWin = null;
let hitWin = null; // invisible, over the pet's body: takes its clicks, drags and touches (see updatePointer)
let panelWin = null;
let tray = null;
let config = null;
let pet = null;
let usage = null;
let activity = null;
let claudeRunning = true;
let hookToken = null;
let hookTokenSaved = false; // the token is the one in hooks-token.json, so it may go into Claude Code's settings
let hookServer = null;
let hookListener = { state: 'off', error: null }; // 'off' | 'starting' | 'listening' | 'failed'

let petPos = null; // top-left of the pet window
let grounded = false;
let facing = 1; // 1 = right, -1 = left
let drag = null;
let glide = null;
let chase = null;
let roam = null;
let nextRoamAt = 0;
let pressed = false; // a press on the pet is under way (the renderer reports when it starts and ends)
const pointer = { overBody: false, hovered: false, hitBounds: null }; // what the windows were last set to
let hiding = false; // the disappear animation is playing; the window hides when it ends
let hideTimer = null;
let greetAt = 0; // when to try the daily greeting (0: not until the pet is shown or wakes)

let statsOpen = false;
let statsSide = 'above'; // which side of the pet the open stats are on
let panelShown = false; // the panel was told to open, and grows from the side nearest the pet
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
    removeHooks: argv.includes('--remove-hooks'), // run by the uninstaller: remove Claude Code hooks and the startup entry
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
// Never dialog.showErrorBox: it blocks the main process, and with it the Claude Code hook listener.
function showNotice(message, detail = '', type = 'warning') {
  console.warn(`[notice] ${message} ${detail}`);
  if (args.snapshot) return;
  dialog.showMessageBox({ type, title: 'Claude Pet', message, detail, buttons: ['OK'] }).catch(() => {});
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
  updatePointer(); // hides the hit area; the pet window itself never takes the mouse
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
  // A trip under way was planned for the old size: head home, to where home is at the new size.
  if (roam) roam.home = resizeAnchored(roam.home, oldSize, PET_SIZE);
  setPetBounds(resizeAnchored(petPos, oldSize, PET_SIZE));
  if (roam) cancelRoam({ returnHome: true });
  else settlePet();
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
  updatePointer(); // a new pose or facing moves the body within the box
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
  if (!trigger || !petVisible() || displayState() === 'sleeping') return false;
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
  if (args.debugHooks) console.log('[hooks]', event, payload?.session_id || '', '->', reactions.join(',') || '-', '| now', activity.summary() || 'quiet');
  // Claude activity shows working poses but doesn't count as touching the pet; it only delays lounging briefly.
  lastClaudeEventAt = Date.now();
  lastClaudeEvent = event;
  reactions.forEach(playEvent);
  if (reactions.includes('taskDone')) rewardPet('taskDone');
  tick();
}

function hookOptions() {
  return { port: config.hooksPort, token: hookToken };
}

// { state: 'missing' | 'current' | 'outdated' | 'unreadable', error }. Snapshot runs never look at Claude Code's settings.
function hooksStatus() {
  if (args.snapshot) return { state: 'missing', error: null };
  return hooksInstaller.readHooksState(hookOptions());
}

// Hooks are only ever pointed at a port this process is really listening on.
function listeningForHooks() {
  return !!hookServer?.listening;
}

function portProblem(installed) {
  return hooksPlan.portProblem({ port: config.hooksPort, error: hookListener.error, installed });
}

function showTokenProblem() {
  const problem = hooksPlan.tokenProblem({ file: tokenPath(userDataDir()) });
  showNotice(problem.message, problem.detail);
}

// Another program held the port while the hooks were sending it the token, so the token isn't trusted any more.
// Claude Code's settings keep the old one until the pet next gets its port, when the hooks are upgraded to the new one.
function renewExposedHookToken() {
  const renewed = renewHookToken(userDataDir());
  if (!renewed.persisted) {
    logError('replacing the Claude Code hooks token', renewed.error);
    return;
  }
  hookToken = renewed.token;
  hookTokenSaved = true;
}

function startHookListener() {
  hookListener = { state: 'starting', error: null };
  try {
    hookServer = startHookServer({
      port: config.hooksPort,
      token: hookToken,
      onEvent: guarded('Claude Code hook', handleHookEvent),
      onStatus: statusSnapshot,
      onError: (err) => logError('hook listener', err),
    });
  } catch (err) {
    listenerSettled({ ok: false, error: err });
    return;
  }
  hookServer.ready.then(guarded('hook listener', listenerSettled));
}

// Once the port is ours (or not): brings hooks from older versions (HTTP hooks, another port or token) up to date,
// and speaks up if Claude Code is sending events to a port someone else holds. The rules are in hooks-plan.js.
function listenerSettled({ ok, error }) {
  hookListener = ok ? { state: 'listening', error: null } : { state: 'failed', error: error?.code || error?.message || String(error) };
  if (!ok) logError(`listening for Claude Code on port ${config.hooksPort}`, error);
  if (quitting) return;
  const plan = hooksPlan.startupHooksPlan({ ok, hooks: hooksStatus(), tokenSaved: hookTokenSaved });
  if (plan.upgrade) {
    try {
      const result = hooksInstaller.upgradeHooks(hookOptions());
      if (result.backupPath) console.log('[hooks] updated; settings backup saved to', result.backupPath);
    } catch (err) {
      logError('updating Claude Code hooks', err);
      showNotice("Claude Pet couldn't update its Claude Code hooks.", `${err.message}\n\nChoose Disconnect from Claude Code… and connect again to retry.`);
    }
  }
  if (plan.renewToken) renewExposedHookToken();
  if (plan.notice === 'portProblem') {
    const problem = portProblem(true);
    showNotice(problem.message, problem.detail);
  }
  if (plan.notice === 'tokenProblem') showTokenProblem();
  refreshTrayMenu();
}

async function toggleHooks() {
  const { state, error } = hooksStatus();
  const action = hooksPlan.hooksAction({ state, listening: listeningForHooks(), tokenSaved: hookTokenSaved });
  if (action === 'unreadable') {
    showNotice("Claude Pet can't read Claude Code's settings, so it can't connect or disconnect.", error, 'error');
    return;
  }
  if (action === 'portProblem') {
    const problem = portProblem(false);
    showNotice(problem.message, problem.detail);
    return;
  }
  if (action === 'tokenProblem') {
    showTokenProblem();
    return;
  }
  const installed = action === 'remove';
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
        + `Each event is sent with curl to the pet on this computer (127.0.0.1:${config.hooksPort}), and Claude Code doesn't wait for it or read the reply. `
        + 'A backup of the file is saved first, and your other settings and hooks are left alone.',
  });
  if (response !== 0) return;
  try {
    if (!installed && !listeningForHooks()) throw new Error(portProblem(false).message);
    const result = installed ? hooksInstaller.uninstallHooks() : hooksInstaller.installHooks(hookOptions());
    if (result.backupPath) console.log('[hooks] settings backup saved to', result.backupPath);
  } catch (err) {
    logError('updating Claude Code settings', err);
    showNotice('Could not update Claude Code settings.', err.message, 'error');
  }
  refreshTrayMenu();
}

function copyTroubleshootingInfo() {
  clipboard.writeText(JSON.stringify(statusSnapshot(), null, 2));
}

// Run by the uninstaller (--remove-hooks): takes the pet's hooks out of Claude Code's settings and removes the
// startup entry, with no windows. The settings folder is left for the user to keep or delete.
function removeHooksAndExit() {
  let failed = false;
  try {
    hooksInstaller.uninstallHooks();
  } catch (err) {
    failed = true;
    logError('removing Claude Code hooks', err);
  }
  try {
    app.setLoginItemSettings(loginItemSettings(false));
  } catch (err) {
    failed = true;
    logError('removing the startup entry', err);
  }
  app.exit(failed ? 1 : 0);
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

// What the pet thinks is going on, for troubleshooting: right-click → Copy troubleshooting info, or
// GET http://127.0.0.1:<hooksPort>/claude-pet/status with the X-Claude-Pet-Token header from hooks-token.json.
function statusSnapshot() {
  const now = Date.now();
  return {
    version: app.getVersion(),
    hooksPort: config.hooksPort,
    hookListener: hookListener.state,
    hookListenerError: hookListener.error,
    claudeCodeHooks: hooksStatus().state,
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
    taskbarEdge: petPos ? taskbarEdge(layoutAt(petCenter()).display) : null, // null: hidden, or not on the pet's display
    statsOpen,
    roaming: !!roam,
    visible: petVisible(),
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
  const options = config.fidgets && !statsOpen && !drag && !chase && !roam && petVisible() ? fidgetsFor(pet, displayState()) : [];
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
    // A hidden window doesn't animate: a hop sent now would play, and reset the pose, whenever it's shown again.
    if (petVisible()) sendReaction(wakeReaction(pet, petState, next));
    if (wokeUp(petState, next)) greetAt = now + GREET_DELAY_MS; // a pet that started asleep says hello once awake
    petState = next;
    pushView();
    if (!chase && !drag && !roam) settleIntoPose(); // a trip settles when it ends
  } else if (now - lastViewPush > VIEW_REFRESH_MS) {
    pushView(); // keeps reset countdowns fresh
  }

  if (roam && !ROAM_STATES.has(petState)) {
    cancelRoam({ returnHome: true }); // Claude needs attention, a limit was hit, etc.
  } else if (!roam && shouldStartRoam({
    mode: config.roam,
    now,
    nextRoamAt,
    state: petState,
    busy: statsOpen || !!drag || !!chase || !petVisible(),
    petIdleMs: now - lastInteraction,
  })) {
    startRoam();
  }
  if (greetAt && now >= greetAt) {
    greetAt = 0;
    greetIfFirstToday(); // skipped while asleep or hidden; tried again when the pet gets up or is shown
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
  if (chase || !petVisible() || displayState() === 'sleeping') return;
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
  movePet({ x: Math.round(petPos.x + (dx / distance) * step), y: Math.round(petPos.y + (dy / distance) * step) });
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

// Body bounds that keep every pose a kind of trip shows on screen ('stroll' or 'wander': on the move and pausing),
// whichever way the pet turns on the way.
function tripInsets(kind) {
  const poses = [false, true].map((pausing) => resolveState(pet, poseForRoam(kind, pausing, config)));
  return combinedInsets(poses.flatMap((pose) => [1, -1].flatMap((direction) => {
    const insets = insetsForState(pet, pose, direction) || ZERO_INSETS;
    return [insets, mirrorInsets(insets, true)];
  })));
}

function startRoam() {
  // The tick would call a trip in any other state straight back home.
  if (roam || chase || drag || !petVisible() || !ROAM_STATES.has(petState)) return;
  closeStats();
  cancelGlide();
  const layout = layoutAt(petCenter());
  // Plan with the bounds of the poses shown, so e.g. a floating tail doesn't dip into the taskbar.
  const clampFor = (kind) => {
    const options = { petSize: PET_SIZE, insets: tripInsets(kind), ...displayLimits(layout.display, layout.displays) };
    return (p) => {
      const placed = clampPet(p, options);
      return { x: placed.x, y: placed.y };
    };
  };
  const plan = planRoam({
    home: { ...petPos },
    mode: config.roam === 'off' ? 'taskbar' : config.roam,
    workArea: layout.display.workArea,
    petSize: PET_SIZE,
    clamp: clampFor('stroll'),
    wanderClamp: clampFor('wander'),
    groundY: groundBelow(petPos.x, { petSize: PET_SIZE, insets: tripInsets('stroll'), ...layout }).y,
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
  settleAfterTrip();
}

// Nothing settles the pet during a trip, and its pose may have changed on the way (it lay down, say).
function settleAfterTrip() {
  updateFacing();
  settleIntoPose();
}

// Stops a trip; returns where home was.
function cancelRoam({ returnHome }) {
  if (!roam) return null;
  clearInterval(roam.timer);
  const { home } = roam;
  roam = null;
  scheduleNextRoam();
  pushView();
  // Home as it fits now: the pose, the size or the screens may have changed since the trip began.
  if (returnHome) glideTo(clampPet(home, placementOptions(petCenter(home))), 500, settleAfterTrip);
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

// The display around a point, with all of them: the pet may cross onto a display next to it (see clampPet).
function layoutAt(point) {
  const displays = screen.getAllDisplays();
  return { display: nearestDisplay(point, displays), displays };
}

function workAreaAt(point) {
  return layoutAt(point).display.workArea;
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

// Limits for the current pose of a pet whose box is centered at `point`: the display there is the one it is on,
// even while a drag or chase heads onto another (where the cursor is doesn't count).
function placementOptions(point = petCenter()) {
  const { display, displays } = layoutAt(point);
  return { petSize: PET_SIZE, insets: currentInsets(), snapPx: SNAP_PX, ...displayLimits(display, displays) };
}

function setPetBounds(pos) {
  if (!windowAlive(petWin)) return;
  petPos = { x: pos.x, y: pos.y };
  petWin.setBounds({ ...petPos, ...PET_SIZE }); // setBounds keeps transparent windows from growing on scaled displays
  if (statsOpen) followWithPanel();
  updatePointer(); // the body may have moved under, or away from, a cursor that stayed still
}

function movePet(pos) {
  const placed = clampPet(pos, placementOptions(petCenter(pos)));
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
  if (start && Number.isFinite(start.x) && Number.isFinite(start.y)) return clampPet(start, placementOptions(petCenter(start)));
  // First run: on the ground at the left of the main display. The main display always has a taskbar, so one that
  // takes no room hides itself, and would slide out over that corner's button (Widgets, or Start): start past it.
  const primary = screen.getPrimaryDisplay();
  const { workArea } = primary;
  const inside = { x: workArea.x + workArea.width / 2, y: workArea.y + workArea.height / 2 };
  const left = workArea.x + (taskbarEdge(primary) ? 24 : AUTO_HIDE_START_X);
  return groundBelow(left, { petSize: PET_SIZE, insets: currentInsets(), ...layoutAt(inside) });
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
  if (drag || chase || roam) return;
  const placed = clampPet(petPos, placementOptions());
  grounded = placed.grounded;
  glideTo(placed, 260, savePetPosition);
}

// Poses occupy different parts of the pet box, so after a pose change settle into the new pose's bounds.
function settleIntoPose() {
  if (displayState() === 'lounging' && config.loungeOnTaskbar) glideToGround();
  else settlePet();
}

function glideToGround() {
  if (drag || chase || roam) return;
  const target = groundBelow(petPos.x, { petSize: PET_SIZE, insets: currentInsets(), ...layoutAt(petCenter()) });
  const distance = Math.hypot(target.x - petPos.x, target.y - petPos.y);
  if (distance > 0) closeStats(); // the panel would be dragged along
  glideTo(target, Math.min(2200, Math.max(300, distance * 2.2)), () => {
    grounded = true;
    updateFacing();
    savePetPosition();
  });
}

// Ends a drag whose release will never reach the pet (it was hidden, or a menu took the mouse): it stays where it is.
function cancelDrag() {
  pressed = false;
  if (!drag) return;
  drag = null;
  sendHeld(false);
  updateFacing();
  settlePet();
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
  const placed = initialPetPosition();
  petPos = { x: placed.x, y: placed.y };
  grounded = placed.grounded;

  petWin = new BrowserWindow({ ...baseWindowOptions(), ...petPos, ...PET_SIZE });
  petWin.setAlwaysOnTop(true, 'floating');
  petWin.setIgnoreMouseEvents(true); // the see-through margins pass clicks on; the hit area takes the body's
  petWin.once('ready-to-show', () => {
    petWin.showInactive();
    updatePointer(); // shows the hit area over the body
    greetAt = Date.now() + GREET_DELAY_MS;
  });
  hideInsteadOfClosing(petWin);
  petWin.on('blur', closeStats); // clicking anywhere else closes the stats
  petWin.webContents.on('did-finish-load', () => {
    pointer.hovered = false; // a freshly loaded page isn't showing a hover
    pushView();
  });
  petWin.loadURL('app://bundle/src/renderer/pet.html');
}

// The pet window never takes input, so an invisible window kept over the body takes the pet's clicks, drags, touches
// and right-clicks. It is never click-through, so a finger lands on it wherever the cursor last was.
function createHitAreaWindow() {
  hitWin = new BrowserWindow({ ...baseWindowOptions(), ...hitAreaBounds(petPos, PET_SIZE, currentInsets()) });
  hitWin.setAlwaysOnTop(true, 'floating');
  hideInsteadOfClosing(hitWin);
  hitWin.on('blur', closeStats); // the window a click on the pet gives focus to: clicking anywhere else closes the stats
  hitWin.webContents.on('did-finish-load', () => {
    pressed = false; // a freshly loaded page has no press under way
    updatePointer();
  });
  hitWin.loadURL('app://bundle/src/renderer/hit-area.html');
}

// Alt+F4 on a focused pet window would destroy it while the app keeps running in the tray: hide the pet instead.
function hideInsteadOfClosing(win) {
  win.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    hidePet();
  });
}

// The pet's window that takes focus and owns its menu: the hit area, unless the pet can't be drawn.
function inputWindow() {
  if (windowAlive(hitWin) && hitWin.isVisible()) return hitWin;
  return windowAlive(petWin) ? petWin : null;
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
  if (!windowAlive(panelWin)) return 'above';
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

// Keeps the open panel by the pet. When it has to change sides (the pet moved, or the card grew), the card's grow
// origin and the pet's stats bubble change sides with it.
function followWithPanel() {
  const side = placePanel();
  if (!statsOpen || side === statsSide) return;
  statsSide = side;
  if (windowAlive(petWin)) petWin.webContents.send('pet:stats', { open: true, side });
  if (panelShown && windowAlive(panelWin)) panelWin.webContents.send('panel:open', side);
}

function clearStatsTimers() {
  statsTimers.forEach(clearTimeout);
  statsTimers = [];
}

// Opening: the orbs fly together and merge first, then the panel grows out of that bubble.
function openStats() {
  if (statsOpen || !petVisible() || !windowAlive(panelWin) || chase) return;
  statsOpen = true;
  // A glide under way (e.g. a clicked roaming pet heading home) carries on; the panel follows the pet.
  markInteraction();
  clearStatsTimers();
  panelShown = false;
  statsSide = placePanel();
  petWin.webContents.send('pet:stats', { open: true, side: statsSide });
  statsTimers.push(setTimeout(() => {
    if (!statsOpen || !windowAlive(panelWin)) return;
    followWithPanel();
    panelWin.showInactive();
    panelWin.webContents.send('panel:open', statsSide);
    panelShown = true;
  }, pet.timings.statsMergeMs * 0.6));
}

// Closing: the panel shrinks back into the bubble, then the bubble splits into orbs again.
function closeStats() {
  if (!statsOpen) return;
  statsOpen = false;
  panelShown = false;
  lastInteraction = Date.now();
  lastInteractionReason = 'stats panel closed';
  clearStatsTimers();
  if (windowAlive(panelWin)) panelWin.webContents.send('panel:close');
  statsTimers.push(setTimeout(() => {
    if (statsOpen) return;
    if (windowAlive(panelWin)) panelWin.hide();
    if (windowAlive(petWin)) petWin.webContents.send('pet:stats', { open: false });
  }, 240));
}

function showStatsFromMenu() {
  if (!windowAlive(petWin)) return;
  if (!petVisible()) showPet();
  inputWindow()?.focus(); // so clicking elsewhere closes it again
  openStats();
}

function showPet() {
  if (!windowAlive(petWin)) return;
  const wasHidden = hiding || !petWin.isVisible();
  clearTimeout(hideTimer); // shown again while it was still disappearing
  hideTimer = null;
  hiding = false;
  petWin.showInactive();
  updatePointer(); // the hit area comes back with the pet
  sendReaction(pet.reactions?.appear); // also undoes a disappear still playing, which would hold the pet invisible
  if (wasHidden) greetAt = Date.now() + GREET_DELAY_MS;
  refreshTrayMenu();
}

function hidePet() {
  if (!petVisible()) return;
  closeStats();
  cancelDrag(); // a hidden window never hears the release
  if (chase) endChase(false);
  const home = cancelRoam({ returnHome: false });
  if (home) movePet(home); // reappear at home, not mid-trip
  // Counts as hidden from now on, so toggling again during the animation shows the pet instead of hiding it twice.
  hiding = true;
  updatePointer(); // a disappearing pet takes no more clicks
  sendReaction(pet.reactions?.disappear);
  hideTimer = setTimeout(guarded('hiding the pet', finishHiding), pet.reactions?.disappear ? pet.timings.disappearMs : 0);
  refreshTrayMenu();
}

function finishHiding() {
  hideTimer = null;
  hiding = false;
  pressed = false; // a hidden pet never hears a release
  if (quitting || !windowAlive(petWin)) return;
  petWin.hide();
  refreshTrayMenu();
}

function toggleVisible() {
  if (!windowAlive(petWin)) return;
  if (petVisible()) hidePet();
  else showPet();
}

// Wave goodbye, fade out, then quit.
function quitWithGoodbye() {
  if (quitting) {
    app.quit(); // asked again while it waves: don't make them wait
    return;
  }
  let waved = false;
  let fades = false;
  try {
    closeStats();
    waved = playEvent('goodbye');
    fades = petVisible() && !!pet.reactions?.disappear;
  } catch (err) {
    logError('saying goodbye', err); // quit anyway
  }
  quitting = true;
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

// A pet playing its disappear animation already counts as hidden.
function petVisible() {
  return windowAlive(petWin) && petWin.isVisible() && !hiding;
}

// Stop every timer before windows are destroyed, so nothing touches a closed window during quit.
function stopTimers() {
  quitting = true;
  appTimers.forEach(clearInterval);
  appTimers = [];
  clearTimeout(clickTimer);
  clearTimeout(hideTimer);
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

// Clicks on the see-through margins of the pet box go to the window below: the pet window never takes the mouse, and
// the hit-area window, kept over the body while the pet can be touched, takes the body's (see click-through.js).
// Checked whenever the pet moves, changes pose, is shown or hidden, on every mouse move over the body, and on a timer.
function updatePointer() {
  if (quitting || !windowAlive(petWin) || !petPos) return;
  placeHitArea();
  if (petDrawFailed || !petWin.isVisible()) return;
  const plan = pointerPlan({
    cursor: screen.getCursorScreenPoint(),
    petPos,
    petSize: PET_SIZE,
    insets: currentInsets(),
    holding: pressed || !!drag,
  });
  pointer.overBody = plan.overBody;
  if (plan.hovered !== pointer.hovered) {
    pointer.hovered = plan.hovered;
    petWin.webContents.send('pet:hover', plan.hovered);
  }
}

function placeHitArea() {
  if (!windowAlive(hitWin)) return;
  if (!petVisible() || petDrawFailed) {
    if (hitWin.isVisible()) hitWin.hide();
    return;
  }
  const bounds = hitAreaBounds(petPos, PET_SIZE, currentInsets());
  const last = pointer.hitBounds;
  if (!last || last.x !== bounds.x || last.y !== bounds.y || last.width !== bounds.width || last.height !== bounds.height) {
    pointer.hitBounds = bounds;
    hitWin.setBounds(bounds);
  }
  if (!hitWin.isVisible()) hitWin.showInactive();
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
  const hooks = hooksPlan.hooksMenu({ state: hooksStatus().state, listenerState: hookListener.state, port: config.hooksPort });
  const visible = petVisible();
  const awake = visible && displayState() !== 'sleeping';
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
        { label: 'Go for a stroll now', enabled: awake && !roam && ROAM_STATES.has(petState), click: startRoam },
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
    { label: visible ? 'Hide pet' : 'Show pet', accelerator: hotkeyLabel ?? undefined, registerAccelerator: false, click: toggleVisible },
    { label: 'Refresh usage now', click: () => usage.refreshNow() },
    { label: 'Open Claude usage page', click: () => shell.openExternal(USAGE_PAGE) },
    { type: 'separator' },
    { label: 'Launch at startup', type: 'checkbox', checked: !!config.launchAtStartup, click: (item) => setLaunchAtStartup(item.checked) },
    ...(hooks.problem ? [hooks.problem] : []),
    { ...hooks.toggle, click: toggleHooks },
    { label: 'Open settings file', click: () => shell.openPath(configPath(userDataDir())) },
    { label: 'Copy troubleshooting info', click: copyTroubleshootingInfo },
    { type: 'separator' },
    { label: 'Quit Claude Pet', click: quitWithGoodbye },
  ]);
}

// The tray menu is built each time it opens, so the Play items, happiness line and hooks item show what's true now.
// That needs the 'right-click' event, which Windows only sends while no menu is attached. Linux never sends it, so
// there the menu stays attached and is rebuilt after the actions that change it.
function refreshTrayMenu() {
  if (process.platform === 'linux') tray?.setContextMenu(buildMenu());
}

function createTray() {
  tray = new Tray(trayIcon());
  tray.on('click', toggleVisible);
  tray.on('right-click', guarded('tray menu', () => tray.popUpContextMenu(buildMenu())));
  refreshTrayMenu();
}

function loginItemSettings(openAtLogin = !!config.launchAtStartup) {
  const devArgs = app.isPackaged ? {} : { path: process.execPath, args: [ROOT] };
  return { openAtLogin, ...devArgs };
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
    if (!petVisible()) return;
    closeStats();
    const cursor = screen.getCursorScreenPoint();
    // Set before a chase ends, so the chase's settle-glide doesn't pull against the hand that's carrying the pet.
    drag = { dx: cursor.x - petPos.x, dy: cursor.y - petPos.y, lastX: cursor.x, lean: 0, lastBonkAt: 0 };
    if (chase) endChase(false);
    cancelRoam({ returnHome: false }); // wherever you drop it becomes home
    cancelGlide();
    shakeDetector.reset();
    markInteraction();
    sendHeld(true);
  });

  ipcMain.on('pet:drag-move', () => {
    if (!drag) return;
    const cursor = screen.getCursorScreenPoint();
    const now = Date.now();
    const desired = { x: cursor.x - drag.dx, y: cursor.y - drag.dy };
    const placed = movePet(desired);

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
    pressed = false;
    if (!drag) {
      updatePointer(); // the drag was already dropped (the pet was hidden, or a menu opened)
      return;
    }
    const { dizzy } = drag;
    drag = null;
    sendHeld(false);
    markInteraction();
    if (dizzy) playEvent('dizzy');
    else if (grounded) playEvent('land');
    updateFacing();
    settlePet();
    tick();
    updatePointer();
  });

  ipcMain.on('pet:press', () => {
    if (!petVisible()) return; // sent just as the pet started to disappear: its release may never come
    pressed = true;
    updatePointer();
  });

  ipcMain.on('pet:release', () => {
    pressed = false;
    updatePointer();
  });

  ipcMain.on('pet:click', () => {
    pressed = false;
    updatePointer();
    registerClick();
  });

  ipcMain.on('pet:hover-move', (_event, x) => {
    updatePointer(); // from the hit area, which can lag a pose change by a moment
    if (drag || chase || !pointer.overBody || !Number.isFinite(x)) return; // only rubbing the body pets the pet
    if (rubDetector.add(x, Date.now())) {
      markInteraction();
      if (playEvent('petted')) rewardPet('petted');
    }
  });

  ipcMain.on('pet:close-stats', closeStats);
  ipcMain.on('pet:context-menu', () => {
    closeStats();
    cancelDrag(); // the menu takes the mouse, so the release never reaches the pet
    const owner = inputWindow();
    if (owner) buildMenu().popup({ window: owner });
  });

  ipcMain.on('panel:clicked', closeStats);
  ipcMain.on('panel:size', (_event, size) => {
    const width = Math.ceil(Number(size?.width));
    const height = Math.ceil(Number(size?.height));
    if (!(width > 0 && height > 0)) return;
    panelSize = { width, height };
    if (statsOpen) followWithPanel();
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
  const loadedToken = loadHookToken(userDataDir());
  hookToken = loadedToken.token;
  hookTokenSaved = loadedToken.persisted;
  if (loadedToken.error) logError('loading the Claude Code hooks token', loadedToken.error);
  if (!args.snapshot || args.debugHooks) startHookListener();

  createPetWindow();
  createHitAreaWindow();
  updateFacing();
  createPanelWindow();
  createTray();
  const hotkeyNotice = registerHotkey();
  if (hotkeyNotice) notices.push(hotkeyNotice);
  if (loginItemAtLaunch(loaded) !== null) syncLoginItem(); // otherwise config holds defaults, not the user's choice

  // Taskbar moved, resolution changed or a monitor was unplugged: keep the pet on screen.
  const reclamp = guarded('keeping the pet on screen', () => {
    pointer.hitBounds = null; // Windows may have resized the hit area for the new display: set its bounds again
    movePet(petPos);
    // A trip was planned for the old layout, and may lead onto a display that's gone: head home instead.
    if (roam) cancelRoam({ returnHome: true });
    else updateFacing();
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
  appTimers.push(
    setInterval(guarded('tick', tick), TICK_MS),
    setInterval(guarded('gaze', trackCursor), LOOK_MS),
    setInterval(guarded('hover', updatePointer), LOOK_MS), // the pet can move under a cursor that stays still
  );
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

if (args.removeHooks) {
  startGuarded(app.whenReady(), removeHooksAndExit, (err) => {
    logError('removing Claude Code hooks', err);
    app.exit(1);
  });
} else {
  startGuarded(app.whenReady(), startApp, failStartup);
}

app.on('before-quit', stopTimers);
app.on('second-instance', () => windowAlive(petWin) && showPet());
app.on('will-quit', () => {
  usage?.saveLoginBeforeExit(); // first: renewed tokens that couldn't be saved yet would be lost for good
  globalShortcut.unregisterAll();
  flushPetPosition();
  clearTimeout(lifeSaveTimer);
  saveLife();
});
