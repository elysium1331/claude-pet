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

  loadURL() {}

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
    cursor: { ...FAR }, idleSeconds: 0,
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
      getDisplayNearestPoint: () => ({ workArea: WORK_AREA }),
      getPrimaryDisplay: () => ({ workArea: WORK_AREA }),
      on() {},
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

async function startMain(t, { idleSeconds = 0 } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pet-main-'));
  const profile = path.join(tmp, 'claude-pet-snapshot');
  fs.mkdirSync(profile);
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({ credentialsPath: path.join(tmp, 'none.json') }));
  const fake = fakeElectron(tmp);
  fake.idleSeconds = idleSeconds;
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
    '--claude-running=true'];
  try {
    require(MAIN);
  } finally {
    process.argv = saved.argv;
  }
  await new Promise((resolve) => setImmediate(resolve)); // startApp runs once the app is "ready"
  assert.equal(fake.exitCode, undefined, errors.join('\n'));

  const [petWin, panelWin] = fake.windows;
  const app = {
    fake,
    petWin,
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
  app.petWin.close();
  assert.equal(app.petWin.isDestroyed(), false);
  app.tick(1000);
  assert.equal(app.petWin.isVisible(), false);
  assert.equal(app.reactions().at(-1), 'disappear');

  app.fake.tray.emit('click');
  assert.equal(app.petWin.isVisible(), true);
  assert.equal(app.reactions().at(-1), 'appear');
  app.send('pet:context-menu');
  assert.equal(app.fake.popups.length, 1);

  app.clickMenu('Quit Claude Pet');
  app.tick(20_000);
  assert.ok(app.fake.quits >= 1);
  assert.equal(app.petWin.isDestroyed(), true); // while quitting the window may close
  assert.deepEqual(app.errors, []);
});

test('hiding can be undone while the pet is still disappearing, and nothing starts meanwhile', async (t) => {
  const app = await startMain(t);
  app.tick(1100);
  app.fake.tray.emit('click');
  assert.ok(menuItem(app.trayMenu(), 'Show pet'), 'counts as hidden as soon as it starts disappearing');
  app.tick(400);
  app.clickMenu('Go for a stroll now');
  app.clickMenu('Chase my cursor');
  app.fake.tray.emit('click');
  app.tick(2000);
  assert.equal(app.petWin.isVisible(), true);
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

test('clicks on the see-through margins go to the window below; the body and a press take the mouse', async (t) => {
  const app = await startMain(t);
  const clickThrough = { ignore: true, forward: true };
  const takesMouse = { ignore: false, forward: false };
  app.tick(100);
  assert.deepEqual(app.petWin.mouse, clickThrough); // cursor far away

  app.fake.cursor = app.bodyCenter();
  app.tick(60); // noticed without the mouse moving over the window, e.g. when the pet moves under it
  assert.deepEqual(app.petWin.mouse, takesMouse);
  assert.deepEqual(app.sent('pet:hover'), [true]);

  app.fake.cursor = app.leftMargin();
  app.send('pet:hover-move', app.fake.cursor.x); // a forwarded mouse move is acted on at once
  assert.deepEqual(app.petWin.mouse, clickThrough);
  assert.deepEqual(app.sent('pet:hover'), [true, false]);

  app.fake.cursor = app.bodyCenter();
  app.send('pet:hover-move', app.fake.cursor.x);
  app.send('pet:press');
  app.fake.cursor = { x: app.fake.cursor.x - 70, y: app.fake.cursor.y - 200 }; // slips off while pressed
  app.tick(60);
  assert.deepEqual(app.petWin.mouse, takesMouse);
  app.send('pet:release');
  assert.deepEqual(app.petWin.mouse, clickThrough);
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
  const marginIsClickThrough = () => {
    app.fake.cursor = app.leftMargin();
    app.tick(60);
    assert.deepEqual(app.petWin.mouse, { ignore: true, forward: true });
  };

  grab();
  app.fake.tray.emit('click'); // the hide hotkey or tray while dragging
  assert.deepEqual(app.sent('pet:held').at(-1), { held: false, lean: 0 });
  app.tick(1000);
  app.fake.tray.emit('click');
  marginIsClickThrough();

  grab();
  app.send('pet:context-menu');
  assert.deepEqual(app.sent('pet:held').at(-1), { held: false, lean: 0 });
  assert.equal(app.fake.popups.length, 1);
  marginIsClickThrough();
  app.send('pet:drag-end'); // arrives late from the renderer: nothing left to end
  assert.deepEqual(app.errors, []);
});
