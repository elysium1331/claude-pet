// Keeps stray errors from freezing or half-starting the app. No Electron imports so it can be unit tested.

// Without these, Electron shows a blocking error box for any stray throw, which freezes the pet and its hook listener.
function logStrayErrors(proc, log) {
  proc.on('uncaughtException', (err) => log('uncaught exception', err));
  proc.on('unhandledRejection', (reason) => log('unhandled promise rejection', reason));
}

// A half-started app would hold the single-instance lock with no window or tray, so every relaunch would do
// nothing: any throw or rejection while starting goes to onFailure, which must exit.
function startGuarded(ready, start, onFailure) {
  return Promise.resolve(ready).then(start).catch(onFailure);
}

// Wraps timer and event callbacks so one bad value can't take down the loop that calls them.
function guarded(log, context, fn) {
  return (...fnArgs) => {
    try {
      return fn(...fnArgs);
    } catch (err) {
      log(context, err);
      return undefined;
    }
  };
}

module.exports = { logStrayErrors, startGuarded, guarded };
