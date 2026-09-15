// Loads the real main process with a fake Electron and mocked timers, to check how the pet window, menus and
// gestures behave together. It runs as a snapshot run with a temporary profile, so no real settings are touched.
const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');

const MAIN = require.resolve('../src/main/main.js');
const ELECTRON = require.resolve('electron');
const WORK_AREA = { x: 0, y: 0, width: 1920, height: 1032 };
const MAIN_DISPLAY = { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: WORK_AREA };
const FAR = { x: 1900, y: 100 };

class FakeWindow extends EventEmitter {
  constructor(options) {
    super();
    this.bounds = { x: options.x ?? 0, y: options.y ?? 0, width: options.width, height: options.height };
    this.visible = false;
    this.destroyed = false;
    this.mouse = null;
    this.webContents = new EventEmitter();
    this.webContents.sent = [];
    this.webContents.send = (channel, payload) => {
      this.alive();
      this.webContents.sent.push([channel, payload]);
    };
    this.webContents.reload = () => {};
    this.webContents.capturePage = async () => ({ toPNG: () => Buffer.alloc(0) });
  }

  alive() {
    if (this.destroyed) throw new TypeError('Object has been destroyed');
  }

  isDestroyed() { return this.destroyed; }

  loadURL(url) { this.url = url; }

  setAlwaysOnTop() { this.alive(); }

  showInactive() {
    this.alive();
    this.visible = true;
  }

  hide() {
    this.alive();
    this.visible = false;
  }

  focus() { this.alive(); }

  isVisible() {
    this.alive();
    return this.visible;
  }

  setBounds(bounds) {
    this.alive();
    this.bounds = { ...bounds };
  }

  getBounds() {
    this.alive();
    return { ...this.bounds };
  }

  setIgnoreMouseEvents(ignore, options) {
    this.alive();
    this.mouse = { ignore, forward: !!options?.forward };
  }

  // What Alt+F4 does: 'close' can be cancelled, otherwise the window is destroyed.
  close() {
    this.alive();
    let prevented = false;
    this.emit('close', { preventDefault: () => { prevented = true; } });
    if (prevented) return;
    this.destroyed = true;
    this.emit('closed');
  }
}

function fakeElectron(tmp) {
  const paths = { temp: tmp, appData: tmp };
  const appEvents = new EventEmitter();
  const fake = {
    windows: [], ipc: {}, popups: [], quits: 0, exitCode: undefined, clipboard: null, tray: null,
    cursor: { ...FAR }, idleSeconds: 0, displays: [MAIN_DISPLAY], screenEvents: new EventEmitter(),
  };
  fake.electron = {
    app: {
      setPath: (name, value) => { paths[name] = value; },
      getPath: (name) => paths[name] ?? tmp,
      requestSingleInstanceLock: () => true,
      whenReady: () => Promise.resolve(),
      on: (event, fn) => appEvents.on(event, fn),
      quit() {
        fake.quits += 1;
        appEvents.emit('before-quit');
        for (const win of fake.windows) if (!win.destroyed) win.close();
      },
      exit: (code) => { fake.exitCode = code; },
      getVersion: () => '0.0.0-test',
      isPackaged: false,
      setLoginItemSettings() {},
    },
    BrowserWindow: class extends FakeWindow {
      constructor(options) {
        super(options);
        fake.windows.push(this);
      }
    },
    Tray: class extends EventEmitter {
      constructor() {
        super();
        this.attached = null;
        this.popped = [];
        fake.tray = this;
      }

      setContextMenu(menu) { this.attached = menu; }

      popUpContextMenu(menu) { this.popped.push(menu); }

      setToolTip() {}

      setImage() {}
    },
    Menu: { buildFromTemplate: (template) => ({ template, popup: () => fake.popups.push(template) }) },
    nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
    nativeTheme: { shouldUseDarkColors: true, on() {} },
    globalShortcut: { register: () => true, unregisterAll() {} },
    ipcMain: { handle() {}, on: (channel, fn) => { fake.ipc[channel] = fn; } },
    protocol: { registerSchemesAsPrivileged() {}, handle() {} },
    net: { fetch() {} },
    screen: {
      getCursorScreenPoint: () => ({ ...fake.cursor }),
      getAllDisplays: () => fake.displays.map((display) => structuredClone(display)), // fresh objects, like Electron's
      getPrimaryDisplay: () => structuredClone(fake.displays[0]),
      on: (event, fn) => fake.screenEvents.on(event, fn),
    },
    shell: { openExternal() {}, openPath() {} },
    powerMonitor: { getSystemIdleTime: () => fake.idleSeconds, on() {} },
    dialog: { showMessageBox: async () => ({ response: 1 }), showErrorBox() {} },
    clipboard: { writeText: (text) => { fake.clipboard = text; } },
  };
  return fake;
}

function menuItem(template, label) {
  for (const item of template) {
    if (item.label === label) return item;
    const found = Array.isArray(item.submenu) ? menuItem(item.submenu, label) : null;
    if (found) return found;
  }
  return null;
}

async function startMain(t, {
  idleSeconds = 0, argv = [], displays = [MAIN_DISPLAY], config = {}, files = {},
} = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pet-main-'));
  const profile = path.join(tmp, 'claude-pet-snapshot');
  fs.mkdirSync(profile);
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({ credentialsPath: path.join(tmp, 'none.json'), ...config }));
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(tmp, name), content);
  const fake = fakeElectron(tmp);
  fake.idleSeconds = idleSeconds;
  fake.displays = displays;
  const errors = [];
  const saved = {
    argv: process.argv,
    configDir: process.env.CLAUDE_CONFIG_DIR,
    listeners: ['uncaughtException', 'unhandledRejection'].map((event) => [event, process.listeners(event)]),
  };
  t.after(() => {
    delete require.cache[MAIN];
    delete require.cache[ELECTRON];
    if (saved.configDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved.configDir;
    for (const [event, before] of saved.listeners) {
      for (const fn of process.listeners(event)) if (!before.includes(fn)) process.removeListener(event, fn);
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: new Date(2026, 8, 15, 12, 0).getTime() });
  t.mock.method(console, 'error', (...parts) => errors.push(parts.join(' ')));
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'log', () => {});
  process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'claude'); // never the real ~/.claude
  const electronModule = new Module(ELECTRON);
  Object.assign(electronModule, { filename: ELECTRON, loaded: true, exports: fake.electron });
  require.cache[ELECTRON] = electronModule;
  delete require.cache[MAIN];
  process.argv = [process.execPath, 'main', `--snapshot=${path.join(tmp, 'snapshot.png')}`, '--snapshot-delay=100000000',
    '--claude-running=true', ...argv.map((arg) => arg.replaceAll('<tmp>', tmp))];
  try {
    require(MAIN);
  } finally {
    process.argv = saved.argv;
  }
  await new Promise((resolve) => setImmediate(resolve)); // startApp runs once the app is "ready"
  assert.equal(fake.exitCode, undefined, errors.join('\n'));

  const page = (name) => fake.windows.find((win) => win.url?.endsWith(`/${name}`));
  const [petWin, hitWin, panelWin] = ['pet.html', 'hit-area.html', 'panel.html'].map(page);
  const app = {
    fake,
    petWin,
    hitWin,
    panelWin,
    errors,
    // Small steps: the mocked clock jumps as far as each tick at once, and glides measure progress with Date.now().
    tick: (ms) => {
      for (let left = ms; left > 0; left -= 16) t.mock.timers.tick(Math.min(16, left));
    },
    send: (channel, ...args) => fake.ipc[channel]({ sender: petWin.webContents }, ...args),
    sent: (channel) => petWin.webContents.sent.filter(([name]) => name === channel).map(([, payload]) => payload),
    reactions: () => app.sent('pet:reaction'),
    trayMenu: () => {
      fake.tray.emit('right-click');
      return (fake.tray.popped.at(-1) ?? fake.tray.attached).template;
    },
    clickMenu: (label) => menuItem(app.trayMenu(), label).click({ checked: true }),
    status: () => {
      app.clickMenu('Copy troubleshooting info');
      return JSON.parse(fake.clipboard);
    },
    bodyCenter: () => ({ x: petWin.getBounds().x + 75, y: petWin.getBounds().y + 80 }),
    leftMargin: () => ({ x: petWin.getBounds().x + 5, y: petWin.getBounds().y + 80 }),
  };
  petWin.emit('ready-to-show');
  return app;
}

const count = (list, name) => list.filter((item) => item === name).length;

test('Alt+F4 on the pet hides it instead of destroying it, and the tray, menus and Quit keep working', async (t) => {
  const app = await startMain(t);
  app.tick(100);
  app.hitWin.close(); // after a click on the pet, the hit area over its body is the window with focus
  assert.equal(app.hitWin.isDestroyed(), false);
  app.tick(1000);
  assert.equal(app.petWin.isVisible(), false);
  assert.equal(app.reactions().at(-1), 'disappear');
  app.petWin.close();
  assert.equal(app.petWin.isDestroyed(), false);

  app.fake.tray.emit('click');
  assert.equal(app.petWin.isVisible(), true);
  assert.equal(app.hitWin.isVisible(), true);
  assert.equal(app.reactions().at(-1), 'appear');
  app.send('pet:context-menu');
  assert.equal(app.fake.popups.length, 1);

  app.clickMenu('Quit Claude Pet');
  app.tick(20_000);
  assert.ok(app.fake.quits >= 1);
  assert.equal(app.petWin.isDestroyed(), true); // while quitting the windows may close
  assert.equal(app.hitWin.isDestroyed(), true);
  assert.deepEqual(app.errors, []);
});

test('hiding can be undone while the pet is still disappearing, and nothing starts meanwhile', async (t) => {
  const app = await startMain(t);
  app.tick(1100);
  app.fake.tray.emit('click');
  assert.ok(menuItem(app.trayMenu(), 'Show pet'), 'counts as hidden as soon as it starts disappearing');
  assert.equal(app.hitWin.isVisible(), false, 'and takes no more clicks');
  app.tick(400);
  app.clickMenu('Go for a stroll now');
  app.clickMenu('Chase my cursor');
  app.fake.tray.emit('click');
  app.tick(2000);
  assert.equal(app.petWin.isVisible(), true);
  assert.equal(app.hitWin.isVisible(), true);
  assert.deepEqual(app.reactions().filter((r) => r === 'appear' || r === 'disappear'), ['disappear', 'appear']);
  const status = app.status();
  assert.equal(status.roaming, false);
  assert.equal(status.shownPose, 'idle');
  assert.deepEqual(app.errors, []);
});

test('the tray menu is built when it opens, so it shows what the pet is doing now', async (t) => {
  const app = await startMain(t);
  app.tick(1100);
  assert.ok(menuItem(app.trayMenu(), 'Hide pet'));
  assert.equal(menuItem(app.trayMenu(), 'Feed a spark').enabled, true);
  app.fake.idleSeconds = 3600; // away from the computer: the pet falls asleep
  app.tick(1000);
  assert.equal(menuItem(app.trayMenu(), 'Feed a spark').enabled, false);
  // Windows only reports right-clicks on a tray icon without an attached menu.
  if (process.platform !== 'linux') assert.equal(app.fake.tray.attached, null);
  assert.deepEqual(app.errors, []);
});

test('a pet that starts asleep says hello once it wakes up, once a day', async (t) => {
  const app = await startMain(t, { idleSeconds: 3600 });
  app.tick(5000);
  assert.equal(count(app.reactions(), 'greet'), 0);
  app.fake.idleSeconds = 0;
  app.tick(1000);
  assert.equal(count(app.reactions(), 'perkUp'), 1);
  app.tick(3000);
  assert.equal(count(app.reactions(), 'greet'), 1);

  app.fake.idleSeconds = 3600;
  app.tick(2000);
  app.fake.idleSeconds = 0;
  app.tick(5000);
  assert.equal(count(app.reactions(), 'greet'), 1);
  assert.deepEqual(app.errors, []);
});

test('a hidden pet that wakes gets no wake-up hop, and says hello when it is shown', async (t) => {
  const app = await startMain(t, { idleSeconds: 3600 });
  app.tick(1100);
  app.fake.tray.emit('click');
  app.tick(1000);
  assert.equal(app.petWin.isVisible(), false);
  const before = app.reactions().length;
  app.fake.idleSeconds = 0;
  app.tick(1000);
  assert.equal(app.status().petState, 'idle');
  assert.deepEqual(app.reactions().slice(before), []);
  app.fake.tray.emit('click');
  assert.deepEqual(app.reactions().slice(before), ['appear']);
  app.tick(3000);
  assert.deepEqual(app.reactions().slice(before), ['appear', 'greet']);
  assert.deepEqual(app.errors, []);
});

test('grabbing a chasing pet does not glide it back toward where it would have settled', async (t) => {
  const app = await startMain(t);
  app.tick(1100);
  app.fake.cursor = { x: 1500, y: 1000 };
  app.clickMenu('Chase my cursor');
  app.tick(300);
  const grabbed = app.petWin.getBounds();
  app.fake.cursor = app.bodyCenter();
  app.send('pet:press');
  app.send('pet:drag-start');
  app.tick(400); // no drag moves: nothing else may move the pet
  assert.deepEqual(app.petWin.getBounds(), grabbed);
  app.send('pet:drag-end');
  assert.deepEqual(app.errors, []);
});

test('opening the stats while a clicked roaming pet heads home lets it get all the way home', async (t) => {
  const app = await startMain(t);
  app.tick(1100);
  const home = app.petWin.getBounds();
  app.clickMenu('Go for a stroll now');
  app.tick(1500);
  assert.notDeepEqual(app.petWin.getBounds(), home);
  app.send('pet:click'); // calls it home
  app.tick(100);
  app.send('pet:click'); // one click on a pet that isn't roaming any more: the stats
  app.tick(1000);
  assert.equal(app.status().statsOpen, true);
  assert.deepEqual(app.petWin.getBounds(), home);
  assert.deepEqual(app.errors, []);
});

const inside = (point, box) => point.x >= box.x && point.x < box.x + box.width
  && point.y >= box.y && point.y < box.y + box.height;

test('the window that draws the pet never takes the mouse; a hit area over the body does, and follows the pet', async (t) => {
  const app = await startMain(t);
  app.tick(1100);
  assert.deepEqual(app.petWin.mouse, { ignore: true, forward: false });
  assert.equal(app.hitWin.isVisible(), true);
  const pet = app.petWin.getBounds();
  const hit = app.hitWin.getBounds();
  assert.ok(inside(app.bodyCenter(), hit));
  assert.ok(!inside(app.leftMargin(), hit), 'the see-through margins pass clicks to the window below');
  assert.ok(hit.x >= pet.x && hit.y >= pet.y && hit.x + hit.width <= pet.x + pet.width
    && hit.y + hit.height <= pet.y + pet.height);

  app.fake.cursor = app.bodyCenter();
  app.send('pet:press');
  app.send('pet:drag-start');
  app.fake.cursor = { x: 600, y: 400 };
  app.send('pet:drag-move');
  const before = { pet: app.petWin.getBounds(), hit: app.hitWin.getBounds() };
  app.fake.cursor = { x: 700, y: 350 };
  app.send('pet:drag-move');
  const after = { pet: app.petWin.getBounds(), hit: app.hitWin.getBounds() };
  assert.notDeepEqual(after.pet, before.pet);
  assert.equal(after.hit.x - before.hit.x, after.pet.x - before.pet.x);
  assert.equal(after.hit.y - before.hit.y, after.pet.y - before.pet.y);
  app.send('pet:drag-end');
  assert.equal(app.hitWin.mouse, null, 'the hit area is never click-through');
  assert.deepEqual(app.errors, []);
});

test('a touch on the body is not lost when the cursor was somewhere else', async (t) => {
  const app = await startMain(t);
  app.tick(1100);
  app.fake.cursor = { ...FAR };
  app.tick(60);
  // A finger doesn't move the cursor before it lands, so nothing may depend on the cursor being over the body first.
  // (Which window Windows gives the touch to can't be simulated here: that the hit area is always shown over the body
  // and never click-through is what makes it land there.)
  assert.equal(app.hitWin.isVisible(), true);
  assert.equal(app.hitWin.mouse, null);
  app.send('pet:press');
  app.send('pet:click');
  app.tick(1000);
  assert.equal(app.status().statsOpen, true);
  assert.deepEqual(app.errors, []);
});

test('the pet looks hovered only with the cursor over its body, or while it is pressed', async (t) => {
  const app = await startMain(t);
  app.tick(100);
  app.fake.cursor = app.bodyCenter();
  app.tick(60); // noticed without the mouse moving, e.g. when the pet moves under a cursor that stays still
  assert.deepEqual(app.sent('pet:hover'), [true]);

  app.fake.cursor = app.leftMargin();
  app.tick(60);
  assert.deepEqual(app.sent('pet:hover'), [true, false]);

  app.fake.cursor = app.bodyCenter();
  app.send('pet:hover-move', app.fake.cursor.x); // a mouse move over the hit area is acted on at once
  assert.deepEqual(app.sent('pet:hover'), [true, false, true]);
  app.send('pet:press');
  app.fake.cursor = { x: app.fake.cursor.x - 70, y: app.fake.cursor.y - 200 }; // slips off while pressed
  app.tick(60);
  assert.deepEqual(app.sent('pet:hover'), [true, false, true]);
  app.send('pet:release');
  assert.deepEqual(app.sent('pet:hover'), [true, false, true, false]);
  assert.deepEqual(app.errors, []);
});

test('a press that starts while the pet disappears does not leave it looking pressed once it is shown again', async (t) => {
  const app = await startMain(t);
  app.tick(1100);
  app.fake.tray.emit('click');
  app.tick(50);
  app.send('pet:press'); // already on its way from the hit area when the pet started to disappear
  app.tick(2000);
  assert.equal(app.petWin.isVisible(), false);
  app.fake.cursor = { ...FAR };
  app.fake.tray.emit('click');
  app.tick(60);
  assert.equal(app.sent('pet:hover').at(-1) ?? false, false);
  assert.deepEqual(app.errors, []);
});

test('a pet that cannot be drawn takes no clicks at all', async (t) => {
  const app = await startMain(t);
  app.tick(1100);
  app.send('pet:load-failed', 'WebGL2 is not available'); // the built-in pet: nothing to fall back to
  app.tick(100);
  assert.equal(app.hitWin.isVisible(), false);
  assert.deepEqual(app.petWin.mouse, { ignore: true, forward: false });
  app.fake.tray.emit('click');
  app.tick(1000);
  app.fake.tray.emit('click'); // shown again: still nothing to catch clicks
  assert.equal(app.hitWin.isVisible(), false);
  assert.deepEqual(app.errors, ['[main] drawing the pet "celestial-fox": WebGL2 is not available']);
});

test('a pet that wakes from sleep straight into lounging still says hello', async (t) => {
  const app = await startMain(t, { idleSeconds: 3600 });
  app.tick(4 * 60_000); // asleep for longer than it takes to lie down
  assert.equal(app.status().petState, 'sleeping');
  app.fake.idleSeconds = 0;
  app.tick(1000);
  assert.equal(app.status().petState, 'lounging');
  app.tick(3000);
  assert.equal(count(app.reactions(), 'greet'), 1);

  app.fake.idleSeconds = 3600;
  app.tick(2000);
  app.fake.idleSeconds = 0;
  app.tick(5000);
  assert.equal(count(app.reactions(), 'greet'), 1);
  assert.deepEqual(app.errors, []);
});

test('rubbing only pets the pet over its body, not over the margins around it', async (t) => {
  const app = await startMain(t);
  app.tick(1100);
  const rub = () => {
    for (let i = 0; i < 8; i += 1) {
      app.send('pet:hover-move', 500 + (i % 2) * 10);
      app.tick(40);
    }
  };
  app.fake.cursor = app.leftMargin();
  rub();
  assert.equal(count(app.reactions(), 'petted'), 0);
  app.fake.cursor = app.bodyCenter();
  rub();
  assert.equal(count(app.reactions(), 'petted'), 1);
  assert.deepEqual(app.errors, []);
});

test('a drag whose release is lost (hidden mid-drag, or the menu opens) is dropped instead of staying stuck', async (t) => {
  const app = await startMain(t);
  app.tick(1100);
  const grab = () => {
    app.fake.cursor = app.bodyCenter();
    app.send('pet:press');
    app.send('pet:drag-start');
    assert.deepEqual(app.sent('pet:held').at(-1), { held: true, lean: 0 });
  };
  const pressIsOver = () => {
    app.fake.cursor = app.leftMargin();
    app.tick(60);
    assert.equal(app.sent('pet:hover').at(-1), false);
  };

  grab();
  app.fake.tray.emit('click'); // the hide hotkey or tray while dragging
  assert.deepEqual(app.sent('pet:held').at(-1), { held: false, lean: 0 });
  app.tick(1000);
  app.fake.tray.emit('click');
  pressIsOver();

  grab();
  app.send('pet:context-menu');
  assert.deepEqual(app.sent('pet:held').at(-1), { held: false, lean: 0 });
  assert.equal(app.fake.popups.length, 1);
  pressIsOver();
  app.send('pet:drag-end'); // arrives late from the renderer: nothing left to end
  assert.deepEqual(app.errors, []);
});

// ---------- movement and placement ----------

const FOX = require('../pets/celestial-fox/pet.json');
const LEFT_DISPLAY = {
  id: 2, bounds: { x: -1920, y: 0, width: 1920, height: 1080 }, workArea: { x: -1920, y: 0, width: 1920, height: 1032 },
};
const UPPER_DISPLAY = { id: 3, bounds: { x: 0, y: -1080, width: 1920, height: 1080 }, workArea: { x: 0, y: -1080, width: 1920, height: 1080 } };

// Top of a pet box of this height whose body, in this pose, rests on the bottom of the work area.
const groundTop = (pose, height = 160, workArea = WORK_AREA) => {
  const insets = FOX.stateInsets[pose] ?? FOX.bodyInsets;
  return Math.round(workArea.y + workArea.height - height + insets.right.bottom * height);
};

test('"Go for a stroll now" is unavailable, and does nothing, while the pet has something else on its mind', async (t) => {
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'usage-response.json'), 'utf8'));
  raw.seven_day.utilization = 95;
  raw.limits.find((limit) => limit.kind === 'weekly_all').percent = 95;
  const app = await startMain(t, { argv: ['--fake-usage=<tmp>/usage.json'], files: { 'usage.json': JSON.stringify(raw) } });
  app.tick(1100);
  assert.equal(app.status().petState, 'lowUsage');
  const before = app.petWin.getBounds();
  assert.equal(menuItem(app.trayMenu(), 'Go for a stroll now').enabled, false);
  app.clickMenu('Go for a stroll now'); // e.g. chosen from a menu opened just before
  assert.equal(app.status().roaming, false);
  app.tick(1500);
  assert.deepEqual(app.petWin.getBounds(), before);
  assert.deepEqual(app.errors, []);
});

test('changing the size during a trip sends the pet home, onto the ground for its new size', async (t) => {
  const app = await startMain(t);
  app.tick(1100);
  const home = app.petWin.getBounds();
  app.clickMenu('Go for a stroll now');
  app.tick(1500);
  assert.notDeepEqual(app.petWin.getBounds(), home);
  app.clickMenu('Extra large');
  assert.equal(app.status().roaming, false);
  app.tick(2000);
  const after = app.petWin.getBounds();
  assert.equal(after.height, 240);
  assert.equal(after.y, groundTop('idle', 240));
  assert.ok(Math.abs(after.x + after.width / 2 - (home.x + home.width / 2)) <= 1, 'home, measured from its bottom center');
  assert.deepEqual(app.errors, []);
});

test('a pet that lies down during a trip settles onto the ground for lounging once it is home', async (t) => {
  // In the middle of the screen, so arriving home never turns it around (which used to be the only thing that settled it).
  const app = await startMain(t, { argv: ['--start-at=885,882'] });
  app.tick(175_000);
  assert.equal(app.status().petState, 'idle');
  app.clickMenu('Go for a stroll now');
  app.tick(10_000); // lies down (3 minutes untouched) along the way
  assert.equal(app.status().petState, 'lounging');
  for (let waited = 0; app.status().roaming && waited < 60_000; waited += 1000) app.tick(1000);
  assert.equal(app.status().roaming, false);
  app.tick(3000);
  assert.equal(app.status().shownPose, 'lounging');
  assert.equal(app.petWin.getBounds().y, groundTop('lounging'));
  assert.deepEqual(app.errors, []);
});

test('a trip on a monitor that is unplugged ends with the pet home on a screen that is still there', async (t) => {
  const app = await startMain(t, { displays: [MAIN_DISPLAY, LEFT_DISPLAY], argv: ['--start-at=-1000,882'] });
  app.tick(1100);
  assert.deepEqual(app.petWin.getBounds(), { x: -1000, y: 882, width: 150, height: 160 });
  app.clickMenu('Go for a stroll now');
  app.tick(1500);
  app.fake.displays = [MAIN_DISPLAY];
  app.fake.screenEvents.emit('display-removed');
  assert.equal(app.status().roaming, false);
  app.tick(3000);
  const { x, y } = app.petWin.getBounds();
  assert.equal(y, groundTop('idle'));
  assert.ok(x >= -18 && x + 150 - 18 <= 1920, `body on the main display (x ${x})`);
  assert.deepEqual(app.errors, []);
});

test('dragging the pet onto the next monitor moves it smoothly, with no bonks or landings at the seam', async (t) => {
  const app = await startMain(t, { displays: [MAIN_DISPLAY, LEFT_DISPLAY, UPPER_DISPLAY] });
  app.tick(1100);
  app.fake.cursor = app.bodyCenter();
  app.send('pet:press');
  app.send('pet:drag-start');
  const dragThrough = (points) => {
    for (const point of points) {
      const before = app.petWin.getBounds();
      app.fake.cursor = point;
      app.send('pet:drag-move');
      app.tick(20);
      const after = app.petWin.getBounds();
      const moved = Math.hypot(after.x - before.x, after.y - before.y);
      assert.ok(moved <= 11, `moved ${moved}px for a 10px drag at ${JSON.stringify(point)}`);
    }
  };
  app.fake.cursor = { x: 99, y: 500 };
  app.send('pet:drag-move');
  // left across x = 0, then back, then up across y = 0
  dragThrough(Array.from({ length: 40 }, (_, i) => ({ x: 99 - 10 * i, y: 500 })));
  dragThrough(Array.from({ length: 40 }, (_, i) => ({ x: -291 + 10 * i, y: 500 })));
  dragThrough(Array.from({ length: 52 }, (_, i) => ({ x: 99, y: 500 - 10 * i })));
  assert.equal(count(app.reactions(), 'bonk'), 0);
  app.send('pet:drag-end'); // the body straddles the two monitors, over no taskbar
  app.tick(1000);
  assert.equal(count(app.reactions(), 'land'), 0);
  assert.equal(app.status().grounded, false);
  assert.ok(app.petWin.getBounds().y < 0 && app.petWin.getBounds().y + 80 > -20, 'left where it was dropped');
  assert.deepEqual(app.errors, []);
});

test('chasing the cursor onto another monitor never jumps the pet across the seam', async (t) => {
  const app = await startMain(t, { displays: [MAIN_DISPLAY, LEFT_DISPLAY, UPPER_DISPLAY] });
  app.tick(1100);
  for (const cursor of [{ x: -900, y: 500 }, { x: 200, y: -500 }]) {
    app.fake.cursor = cursor;
    app.clickMenu('Chase my cursor');
    let before = app.petWin.getBounds();
    for (let i = 0; i < 100; i += 1) {
      app.tick(30);
      const after = app.petWin.getBounds();
      assert.ok(Math.hypot(after.x - before.x, after.y - before.y) <= 16, `one chase step from ${JSON.stringify(before)} to ${JSON.stringify(after)}`);
      before = after;
    }
    app.tick(8000); // the chase gives up
  }
  assert.deepEqual(app.errors, []);
});

// A monitor to the left without a taskbar (Windows shows it on the main display only): its ground is lower.
const BARE_LEFT_DISPLAY = { id: 4, bounds: LEFT_DISPLAY.bounds, workArea: LEFT_DISPLAY.bounds };

test('dragging the pet along the ground onto a monitor without a taskbar, and back, never jumps or bonks', async (t) => {
  const app = await startMain(t, { displays: [MAIN_DISPLAY, BARE_LEFT_DISPLAY] });
  app.tick(1100);
  const grab = app.bodyCenter();
  app.fake.cursor = grab;
  app.send('pet:press');
  app.send('pet:drag-start');
  const heldGround = Math.round(WORK_AREA.height - 160 + FOX.stateInsets.held.bottom * 160);
  const dragThrough = (points) => {
    const climbs = [];
    for (const point of points) {
      const before = app.petWin.getBounds();
      app.fake.cursor = point;
      app.send('pet:drag-move');
      app.tick(20);
      const after = app.petWin.getBounds();
      assert.ok(Math.abs(after.x - before.x) <= 10, `x ${before.x} -> ${after.x} for a 10px drag at ${JSON.stringify(point)}`);
      if (Math.hypot(after.x - before.x, after.y - before.y) > 11) climbs.push(after);
    }
    return climbs;
  };
  // Left along the taskbar, the cursor 4px below where it holds the pet: onto the bare monitor, following it down.
  const low = grab.y + (heldGround - app.petWin.getBounds().y) + 4;
  dragThrough([{ x: grab.x, y: low }]);
  assert.deepEqual(dragThrough(Array.from({ length: 40 }, (_, i) => ({ x: grab.x - 10 * i, y: low }))), []);
  assert.equal(app.petWin.getBounds().y, heldGround + 4);
  // Down onto the bare monitor's ground, then back right: one step up onto the taskbar at the seam.
  app.fake.cursor = { x: grab.x - 390, y: 1075 };
  app.send('pet:drag-move');
  const climbs = dragThrough(Array.from({ length: 40 }, (_, i) => ({ x: grab.x - 390 + 10 * i, y: 1075 })));
  assert.equal(climbs.length, 1);
  assert.equal(climbs[0].y, heldGround);
  assert.equal(count(app.reactions(), 'bonk'), 0);
  app.send('pet:drag-end');
  assert.deepEqual(app.errors, []);
});

test('chasing the cursor down onto a monitor without a taskbar never jumps the pet across the seam', async (t) => {
  const bareRight = { id: 5, bounds: { x: 1920, y: 0, width: 1920, height: 1080 }, workArea: { x: 1920, y: 0, width: 1920, height: 1080 } };
  const app = await startMain(t, { displays: [MAIN_DISPLAY, bareRight], argv: ['--start-at=1843,876'] });
  app.tick(1100);
  const ground = groundTop('chasing', 160, bareRight.bounds) - 4;
  app.fake.cursor = { x: 2400, y: 1060 };
  app.clickMenu('Chase my cursor');
  let before = app.petWin.getBounds();
  for (let i = 0; i < 100 && app.status().shownPose === 'chasing'; i += 1) {
    app.tick(30);
    const after = app.petWin.getBounds();
    const moved = Math.hypot(after.x - before.x, after.y - before.y);
    // Near the ground it snaps onto it, as on any one screen.
    assert.ok(moved <= 16 || (after.y === ground && Math.abs(after.x - before.x) <= 14), `one chase step from ${JSON.stringify(before)} to ${JSON.stringify(after)}`);
    before = after;
  }
  assert.ok(before.x > 1920, 'it got onto the other monitor');
  assert.deepEqual(app.errors, []);
});

test('a wander planned while strolls walk is kept on screen with the floating pose\'s bounds', async (t) => {
  const wide = { id: 1, bounds: { x: 0, y: 0, width: 5120, height: 1440 }, workArea: { x: 0, y: 0, width: 5120, height: 1392 } };
  const app = await startMain(t, {
    displays: [wide], argv: ['--start-at=4880,1200'], config: { roam: 'screen', strollPose: 'walk', taskbarPose: 'sit', petScale: 1.5 },
  });
  app.tick(1100);
  app.fake.cursor = { x: 2560, y: 20 };
  // Every draw 0.1: a wander (not a stroll) far to the left, bowed so the way back arcs up past the top of the screen.
  const random = t.mock.method(Math, 'random', () => 0.1);
  app.clickMenu('Go for a stroll now');
  random.mock.restore();
  assert.equal(app.status().roaming, true);
  const floatingTop = FOX.stateInsets.floatingTravel.right.top;
  let highest = Infinity;
  for (let waited = 0; app.status().roaming && waited < 120_000; waited += 250) {
    app.tick(250);
    const { y, height } = app.petWin.getBounds();
    highest = Math.min(highest, y + floatingTop * height);
  }
  assert.equal(app.status().roaming, false);
  assert.ok(highest >= 0 && highest < 20, `the floating body's top reached ${highest}, just inside the top of the screen`);
  assert.deepEqual(app.errors, []);
});

test('on first run with an auto-hidden taskbar, the pet starts clear of the button at the far left of it', async (t) => {
  const bounds = { x: 0, y: 0, width: 1920, height: 1080 };
  const hidden = await startMain(t, { displays: [{ id: 1, bounds, workArea: bounds }] });
  hidden.tick(1100);
  assert.ok(hidden.petWin.getBounds().x >= 200, `x ${hidden.petWin.getBounds().x}`);
  assert.deepEqual(hidden.errors, []);
});

test('on first run with the taskbar showing, the pet starts at the left end of it', async (t) => {
  const app = await startMain(t);
  app.tick(1100);
  assert.equal(app.petWin.getBounds().x, 24);
  assert.deepEqual(app.errors, []);
});

test('with the taskbar hidden, the pet rests just above the bottom of the screen, clear of the strip that reveals it', async (t) => {
  const bounds = { x: 0, y: 0, width: 1920, height: 1080 };
  const app = await startMain(t, { displays: [{ id: 1, bounds, workArea: bounds }] });
  app.tick(1100);
  const pet = app.petWin.getBounds();
  assert.equal(pet.y, groundTop('idle', 160, bounds) - 4);
  const hit = app.hitWin.getBounds();
  assert.ok(hit.y + hit.height <= 1076, 'the hit area over the body stays off the last rows of the screen');
  const status = app.status();
  assert.equal(status.grounded, true);
  assert.equal(status.taskbarEdge, null);
  assert.deepEqual(app.errors, []);
});

test('the stats panel changes sides with the card when it grows past the room above the pet', async (t) => {
  const app = await startMain(t, { argv: ['--start-at=885,250'] });
  app.tick(1100);
  const panelSent = (channel) => app.panelWin.webContents.sent.filter(([name]) => name === channel).map(([, payload]) => payload);
  app.send('pet:click');
  app.tick(1000);
  assert.deepEqual(panelSent('panel:open'), ['above']);
  assert.deepEqual(app.sent('pet:stats').at(-1), { open: true, side: 'above' });

  app.fake.ipc['panel:size']({ sender: app.panelWin.webContents }, { width: 244, height: 300 }); // the usage arrived
  assert.deepEqual(panelSent('panel:open'), ['above', 'below']);
  assert.deepEqual(app.sent('pet:stats').at(-1), { open: true, side: 'below' });
  assert.ok(app.panelWin.getBounds().y > app.petWin.getBounds().y + 80, 'the panel is below the pet');

  app.fake.ipc['panel:size']({ sender: app.panelWin.webContents }, { width: 244, height: 300 });
  assert.equal(panelSent('panel:open').length, 2, 'nothing more to say while it stays on that side');
  assert.deepEqual(app.errors, []);
});
