// Tiny local HTTP listener that Claude Code hooks post their event JSON to, plus a status check for troubleshooting.
// Only accepts requests addressed to 127.0.0.1, and refuses anything a web page could send, so sites can't poke the pet.
const http = require('node:http');

const HOOK_PATH = /^\/claude-pet\/hook\/([A-Za-z]+)$/;
const STATUS_PATH = '/claude-pet/status';
const MAX_BODY = 1024 * 1024;

function startHookServer({ port, onEvent, onStatus = () => ({}) }) {
  const server = http.createServer((req, res) => {
    const actualPort = server.address()?.port ?? port;
    const localHost = req.headers.host === `127.0.0.1:${actualPort}` || req.headers.host === `localhost:${actualPort}`;
    // Web pages can only send "simple" content types without a preflight, and always send Origin on POSTs.
    const contentType = req.headers['content-type'] || '';
    const browserSimple = /^(text\/plain|application\/x-www-form-urlencoded|multipart\/form-data)/i.test(contentType);
    if (!localHost || req.headers.origin) {
      res.writeHead(404).end();
      return;
    }

    if (req.method === 'GET' && req.url === STATUS_PATH) {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(onStatus(), null, 2));
      return;
    }

    const match = req.method === 'POST' && HOOK_PATH.exec(req.url);
    if (!match || browserSimple) {
      res.writeHead(404).end();
      return;
    }

    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > MAX_BODY) req.destroy();
    });
    req.on('end', () => {
      // An empty JSON object: no decision, nothing added to Claude's context.
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}');
      let payload = {};
      try {
        payload = JSON.parse(body);
      } catch {
        // keep the event even if the payload is unreadable
      }
      onEvent(match[1], payload);
    });
  });
  server.on('error', (err) => console.warn(`[hooks] listener on port ${port} failed:`, err.message));
  server.listen(port, '127.0.0.1');
  return server;
}

module.exports = { startHookServer };
