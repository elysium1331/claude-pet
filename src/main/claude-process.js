// Detects whether the Claude app (or Claude Code) is running, including when it's only in the tray.
const { execFile } = require('node:child_process');

// tasklist can hang when WMI/RPC is broken or antivirus is busy; never wait on it forever.
const DETECT_TIMEOUT_MS = 10_000;

function listProcessNames({ run = execFile, timeoutMs = DETECT_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const [cmd, args] = process.platform === 'win32'
      ? ['tasklist', ['/FO', 'CSV', '/NH']]
      : ['ps', ['-A', '-o', 'comm=']];
    const options = { windowsHide: true, maxBuffer: 4 * 1024 * 1024, timeout: timeoutMs, killSignal: 'SIGKILL' };
    run(cmd, args, options, (err, stdout) => {
      if (err) return resolve(null);
      const names = String(stdout)
        .split(/\r?\n/)
        .map((line) => (process.platform === 'win32' ? line.split('","')[0].replace(/^"/, '') : line.split('/').pop()))
        .map((name) => name.trim().toLowerCase())
        .filter(Boolean);
      resolve(new Set(names));
    });
  });
}

async function isClaudeRunning(processNames, options) {
  const running = await listProcessNames(options);
  if (!running) return true; // if detection fails, assume awake rather than hiding usage
  const names = Array.isArray(processNames) ? processNames.filter((name) => typeof name === 'string') : [];
  return names.some((name) => running.has(name.toLowerCase()));
}

module.exports = { isClaudeRunning, DETECT_TIMEOUT_MS };
