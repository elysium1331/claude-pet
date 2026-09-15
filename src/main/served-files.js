// Maps app:// URL paths onto the few folders the windows may load from, refusing anything outside them.
const path = require('node:path');

// mounts: [{ prefix: 'pets/', dir }]. Returns an absolute file path, or null when the request isn't allowed.
function resolveServedFile(pathname, mounts) {
  let relative;
  try {
    relative = decodeURIComponent(pathname).replace(/^\/+/, '');
  } catch {
    return null; // malformed %-escape
  }
  const mount = mounts.find((m) => relative.startsWith(m.prefix));
  if (!mount) return null;
  const root = path.resolve(mount.dir);
  const file = path.resolve(root, relative.slice(mount.prefix.length));
  return file.startsWith(root + path.sep) ? file : null;
}

module.exports = { resolveServedFile };
