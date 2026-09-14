# Claude Pet

An animated desktop pet that shows your Claude plan usage at a glance: your current session, your weekly limit, and any per-model weekly limit, each with its reset time.

> **Unofficial.** Claude Pet is a community project and is not affiliated with or endorsed by Anthropic. It reads usage from an undocumented endpoint that can change or break at any time.

![Celestial fox preview](pets/celestial-fox/preview-dark.png)

## What it does

- Sits on your taskbar (bottom-left by default). Drag it anywhere; it stays on screen and snaps back onto the taskbar when you drop it near it.
- The three orbs orbiting the pet are your meters: one dot = session, two = weekly, three = your per-model weekly limit (e.g. Fable). Their rings fill and turn amber, then red, as you use more.
- Click the pet to open the full stats: percentages, bars, reset times and countdowns. Click again, or anywhere else, to close.
- Left alone for a few minutes, it drifts down to the taskbar and lounges. It sleeps when you're away from the computer or the Claude app isn't running, and checks usage less often while it naps.
- Gets worried near your limits, sighs and gets tired when one is hit, and celebrates when a limit resets (the orbs drain and refill).
- Waves hello once a day, looks for a connection if it can't read your usage, and waves goodbye when you quit.
- Tray icon: show/hide, refresh now, open Claude's usage page, launch at startup, settings.
- `Ctrl+Alt+P` hides or shows it (for windowed games, screen shares, and so on). While hidden it stays silent.

## Requirements

- Windows 10/11 (macOS/Linux may work but are untested)
- [Node.js](https://nodejs.org) 20+
- A Claude Pro or Max plan, signed in to **Claude Code** on this computer

## Install and run

```bash
git clone https://github.com/elysium1331/claude-pet.git
cd claude-pet
npm install
npm start
```

If `npm start` says Electron failed to install, run `node node_modules/electron/install.js` once and try again.

## How it gets your usage

Claude Pet uses the login that Claude Code already saved on your computer (`~/.claude/.credentials.json`) to ask Anthropic for your plan usage, about every 2 minutes (every 10 while Claude is closed). Checking usage does not use up any of your usage.

- Your token is only ever sent to Anthropic. It is never logged, copied or uploaded anywhere else.
- When the saved login expires, Claude Pet renews it the same way Claude Code does and saves it back to the same file.
- If it shows **Sign in needed**, open a terminal, run `claude` once, then `/exit`.

## Settings

Right-click the pet or the tray icon and choose **Open settings file**. Restart the pet after editing.

| Setting | Default | What it does |
|---|---|---|
| `pollMinutes` | `2` | How often to check usage while Claude is running |
| `idlePollMinutes` | `10` | How often to check while Claude is closed |
| `warnAtPercent` | `85` | When the pet starts looking worried |
| `loungeAfterMinutes` | `3` | Minutes without touching the pet before it lies down |
| `loungeOnTaskbar` | `true` | Drift down onto the taskbar before lounging |
| `sleepWhenAwayMinutes` | `10` | Minutes without keyboard/mouse input before it sleeps |
| `fidgets` | `true` | Occasional idle animations (if the pet has them) |
| `hideHotkey` | `CommandOrControl+Alt+P` | Show/hide shortcut |
| `launchAtStartup` | `false` | Also toggleable from the tray menu |
| `claudeProcessNames` | `["claude.exe", "claude"]` | Processes that count as "Claude is running" |
| `scopedLimit` | `null` | Which per-model weekly limit to show (e.g. `"Fable"`); `null` = first one reported |
| `lightBackdrop` | `"auto"` | Stronger outline for light desktops: `true`, `false`, or `"auto"` (follows Windows theme) |
| `credentialsPath` | `null` | Custom path to Claude Code's credentials file |
| `pet` | `"celestial-fox"` | Folder name under `pets/` |

## Make your own pet

A pet is a folder in `pets/` with a [Rive](https://rive.app) file and a `pet.json` that maps the app's values onto the file's view model:

```json
{
  "name": "Celestial Fox",
  "file": "celestial-fox.riv",
  "artboard": "CelestialFox",
  "stateMachine": "PetStateMachine",
  "binding": {
    "stateProperty": "state",
    "usageProperties": { "session": "session", "weekly": "weekly", "model": "fable" },
    "lightBackdropProperty": "lightBackdrop"
  },
  "states": { "idle": 0, "sleeping": 1, "working": 2, "needsAttention": 3, "done": 4, "idea": 5, "lowUsage": 6, "limitReached": 7 }
}
```

- `stateProperty`: a Number the app sets to one of the `states` values.
- `usageProperties`: Numbers (0–100) for the orbs. Leave any out if your pet has no meters; the chips under the pet always show the numbers.
- `lightBackdropProperty`: an optional Boolean.
- Optional extras: `usageColorProperties` (Colors for the orb rings), `statsOpenProperty` / `statsSideProperty`, `hoveredProperty`, `lookXProperty` / `lookYProperty` (gaze, -1..1).
- `reactions`: view-model Trigger names for `wake`, `appear` and `disappear`; `fidgets`: `{ "trigger", "ms", "states" }` entries played at random while idle (or in the listed states).
- `bodyInsets` / `stateInsets`: how much of the pet box is transparent margin on each side (fractions), overall and per pose, so the body stays on screen.

See [pets/celestial-fox/state-map.md](pets/celestial-fox/state-map.md) for a full example.

## Development

```bash
npm test
```

Useful flags for `npx electron .`:

- `--fake-usage=path/to/usage.json`: use a saved response instead of the network
- `--claude-running=true|false`: override Claude app detection
- `--pet-state=lounging`: force a pet state
- `--start-at=x,y`: start the pet at a screen position (it is clamped on screen)
- `--snapshot=out.png [--snapshot-stats]`: save a picture of the pet (and the stats panel), then quit

## License

TBD
