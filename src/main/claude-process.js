// Detects whether the Claude app (or Claude Code) is running, including when it's only in the tray.
const { execFile } = require('node:child_process');

function listProcessNames() {
  return new Promise((resolve) => {
    const [cmd, args] = process.platform === 'win32'
      ? ['tasklist', ['/FO', 'CSV', '/NH']]
      : ['ps', ['-A', '-o', 'comm=']];
    execFile(cmd, args, { windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve(null);
      const names = stdout
        .split(/\r?\n/)
        .map((line) => (process.platform === 'win32' ? line.split('","')[0].replace(/^"/, '') : line.split('/').pop()))
        .map((name) => name.trim().toLowerCase())
        .filter(Boolean);
      resolve(new Set(names));
    });
  });
}

async function isClaudeRunning(processNames) {
  const running = await listProcessNames();
  if (!running) return true; // if detection fails, assume awake rather than hiding usage
  return processNames.some((name) => running.has(name.toLowerCase()));
}

module.exports = { isClaudeRunning };
