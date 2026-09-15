// Where Claude Code keeps its settings and saved login. Shared so hooks and usage always look in the same folder.
const os = require('node:os');
const path = require('node:path');

// Claude Code uses CLAUDE_CONFIG_DIR when it is set, otherwise ~/.claude.
function claudeConfigDir(env = process.env, home = os.homedir()) {
  const dir = env.CLAUDE_CONFIG_DIR;
  return typeof dir === 'string' && dir.trim() !== '' ? dir : path.join(home, '.claude');
}

module.exports = { claudeConfigDir };
