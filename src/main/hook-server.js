// Tiny local HTTP listener that Claude Pet's Claude Code hooks send their event JSON to, plus a status check for
// troubleshooting. Web pages are refused first: the Host must be 127.0.0.1 or localhost with this port (so DNS
// rebinding fails), and any Origin header is refused, since browsers add one to every cross-site POST and fetch,
// including a no-cors fetch with no Content-Type, which skips the CORS preflight. After that every request must carry
// the per-install token, which other programs and accounts on the same PC can't read.
const http = require('node:http');
const { TOKEN_HEADER, tokenMatches } = require('./hooks-token');

const HOOK_PATH = /^\/claude-pet\/hook\/([A-Za-z]+)$/;
const STATUS_PATH = '/claude-pet/status';
const MAX_BODY = 1024 * 1024; // parsed in full up to this size
const TAIL_CHARS = 64 * 1024;
const PARTIAL_FIELDS = ['session_id', 'hook_event_name', 'agent_id', 'tool_name', 'tool_use_id', 'notification_type'];

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

function parsePayload(text) {
  try {
    const value = JSON.parse(text);
    return isPlainObject(value) ? value : {};
  } catch {
    return {}; // keep the event even if the payload is unreadable
  }
}

// A body too big to keep (a Write of a large file, say): pick out the few short fields the pet uses. Claude Code
// sends them before tool_input, except tool_use_id, which comes last, so both ends of the body are searched.
function fieldsFromPartialBody(head, tail) {
  const inputAt = head.indexOf('"tool_input"');
  const before = inputAt >= 0 ? head.slice(0, inputAt) : head;
  const payload = {};
  for (const field of PARTIAL_FIELDS) {
    const pattern = new RegExp(`"${field}"\\s*:\\s*("(?:[^"\\\\]|\\\\.){1,512}")`, 'g');
    const candidates = [...before.matchAll(pattern)].slice(0, 1);
    if (field === 'tool_use_id') candidates.unshift(...[...tail.matchAll(pattern)].slice(-1));
    for (const [, quoted] of candidates) {
      try {
        payload[field] = JSON.parse(quoted);
        break;
      } catch {
        // cut in the middle of an escape: try the other end
      }
    }
  }
  return payload;
}

// Returns the server; `server.ready` resolves to { ok, error } once it is listening or has failed (port in use).
function startHookServer({
  port, token, onEvent, onStatus = () => ({}), onError = (err) => console.warn('[hooks]', err.message),
}) {
  const report = (err) => {
    try {
      onError(err);
    } catch {
      // reporting must never throw
    }
  };

  const server = http.createServer((req, res) => {
    req.on('error', () => {}); // a client that hangs up mid-request
    const actualPort = server.address()?.port ?? port;
    const localHost = req.headers.host === `127.0.0.1:${actualPort}` || req.headers.host === `localhost:${actualPort}`;
    if (!localHost || req.headers.origin !== undefined) {
      res.writeHead(404).end();
      return;
    }
    if (!tokenMatches(token, req.headers[TOKEN_HEADER.toLowerCase()])) {
      res.writeHead(403).end();
      return;
    }

    if (req.method === 'GET' && req.url === STATUS_PATH) {
      let text;
      try {
        text = JSON.stringify(onStatus(), null, 2);
      } catch (err) {
        report(err);
        res.writeHead(500).end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(text);
      return;
    }

    // Also refuse the content types a page may send without a preflight.
    const contentType = req.headers['content-type'] || '';
    const browserSimple = /^(text\/plain|application\/x-www-form-urlencoded|multipart\/form-data)/i.test(contentType);
    const match = req.method === 'POST' && HOOK_PATH.exec(req.url);
    if (!match || browserSimple) {
      res.writeHead(404).end();
      return;
    }

    let head = '';
    let tail = '';
    let truncated = false;
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      if (!truncated && head.length + chunk.length <= MAX_BODY) {
        head += chunk;
        return;
      }
      if (!truncated) {
        truncated = true;
        tail = head;
        head = (head + chunk).slice(0, MAX_BODY);
      }
      tail = (tail + chunk).slice(-TAIL_CHARS);
    });
    req.on('end', () => {
      // Command hooks ignore the reply. For HTTP hooks from older versions, an empty object means no decision.
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}');
      const payload = truncated ? fieldsFromPartialBody(head, tail) : parsePayload(head);
      try {
        onEvent(match[1], payload);
      } catch (err) {
        report(err);
      }
    });
  });

  server.ready = new Promise((resolve) => {
    server.once('listening', () => resolve({ ok: true, error: null }));
    server.once('error', (err) => resolve({ ok: false, error: err }));
  });
  server.on('error', (err) => {
    if (server.listening) report(err); // failing to listen is reported through `ready`
  });
  server.listen(port, '127.0.0.1');
  return server;
}

module.exports = { startHookServer, fieldsFromPartialBody, parsePayload, MAX_BODY };
