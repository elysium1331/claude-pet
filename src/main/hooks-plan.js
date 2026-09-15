// What the pet does about its Claude Code hooks at startup and from the menu. Kept free of Electron so these rules,
// which decide where Claude Code sends prompts and tool I/O, have tests.

const isInstalled = (state) => state === 'current' || state === 'outdated';
const NOTHING = { upgrade: false, renewToken: false, notice: null };

// Once the listener has settled. hooks: readHooksState(); tokenSaved: the token is the one kept in hooks-token.json.
// Returns { upgrade, renewToken, notice: null | 'portProblem' | 'tokenProblem' }.
function startupHooksPlan({ ok, hooks, tokenSaved }) {
  if (!isInstalled(hooks.state)) return NOTHING;
  if (ok) {
    if (hooks.state === 'current') return NOTHING;
    // A token that isn't saved would be gone next launch, so every Claude Code event would be turned away.
    return tokenSaved ? { ...NOTHING, upgrade: true } : { ...NOTHING, notice: 'tokenProblem' };
  }
  // Another program may hold the port, so hooks are never moved to it. Old HTTP hooks that already send there are
  // made async, so it can't answer for Claude Code; that hands it the token, as current hooks already do. Then the
  // token is replaced, and the hooks get the new one once the pet has its port. Hooks already sending an older token
  // there are left alone, so launches while the port stays taken don't keep rewriting Claude Code's settings.
  const makeAsync = hooks.state === 'outdated' && hooks.samePort && hooks.replyUsed && tokenSaved;
  return { upgrade: makeAsync, renewToken: makeAsync || hooks.sendsToken, notice: 'portProblem' };
}

// What Connect/Disconnect does: 'unreadable' | 'remove' | 'portProblem' | 'tokenProblem' | 'install'.
// Hooks are only installed while this process listens on their port, with a token that outlasts a restart.
function hooksAction({ state, listening, tokenSaved }) {
  if (state === 'unreadable') return 'unreadable';
  if (isInstalled(state)) return 'remove';
  if (!listening) return 'portProblem';
  if (!tokenSaved) return 'tokenProblem';
  return 'install';
}

// The Claude Code lines of the menu: { problem: item | null, toggle: item }.
function hooksMenu({ state, listenerState, port }) {
  return {
    problem: listenerState === 'failed'
      ? { label: `Claude Code events can't reach the pet (port ${port} is unavailable)`, enabled: false }
      : null,
    // Enabled even when Claude Code's settings can't be read: clicking it explains what is wrong.
    toggle: { label: isInstalled(state) ? 'Disconnect from Claude Code…' : 'Connect to Claude Code…', enabled: true },
  };
}

function portProblem({ port, error, installed }) {
  const reason = error === 'EADDRINUSE' ? 'another program is using it' : `it can't be used (${error})`;
  return {
    message: `Claude Pet can't receive Claude Code events on port ${port}: ${reason}.`,
    detail: installed
      ? `Claude Code is still set up to send its events to port ${port}, where that program gets them instead of the pet. `
        + 'Choose Disconnect from Claude Code… to stop that, or set hooksPort in the settings file to a free port '
        + '(1024–65535) and restart Claude Pet, which moves its hooks to the new port.'
      : 'Set hooksPort in the settings file to a free port (1024–65535), restart Claude Pet, then connect again.',
  };
}

function tokenProblem({ file }) {
  return {
    message: "Claude Pet couldn't load its Claude Code hooks token, so it left Claude Code's settings as they are.",
    detail: `${file} couldn't be read or saved. Check that it isn't locked or read-only, then restart Claude Pet.`,
  };
}

module.exports = { startupHooksPlan, hooksAction, hooksMenu, portProblem, tokenProblem };
