const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { startHookServer, fieldsFromPartialBody, MAX_BODY } = require('../src/main/hook-server');

const TOKEN = 'T0ken'.repeat(8);

function request(port, { method = 'GET', path, headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

async function withServer(options, run) {
  const server = startHookServer({ port: 0, token: TOKEN, onEvent: () => {}, ...options });
  assert.deepEqual(await server.ready, { ok: true, error: null });
  try {
    await run(server.address().port);
  } finally {
    server.close();
  }
}

const hookHeaders = (port, extra = {}) => ({
  'content-type': 'application/json', host: `127.0.0.1:${port}`, 'x-claude-pet-token': TOKEN, ...extra,
});

test('hook events are delivered and answered with an empty JSON object', async () => {
  const events = [];
  await withServer({ onEvent: (name, payload) => events.push([name, payload]) }, async (port) => {
    const res = await request(port, {
      method: 'POST', path: '/claude-pet/hook/Stop', headers: hookHeaders(port), body: JSON.stringify({ session_id: 'abc' }),
    });
    assert.equal(res.status, 200);
    assert.equal(res.body, '{}');
  });
  assert.deepEqual(events, [['Stop', { session_id: 'abc' }]]);
});

test('hook events without the right token are refused', async () => {
  const events = [];
  await withServer({ onEvent: (name) => events.push(name) }, async (port) => {
    for (const token of [undefined, '', 'guess', TOKEN.toLowerCase(), `${TOKEN}x`]) {
      const headers = hookHeaders(port);
      if (token === undefined) delete headers['x-claude-pet-token'];
      else headers['x-claude-pet-token'] = token;
      const res = await request(port, { method: 'POST', path: '/claude-pet/hook/PermissionRequest', headers, body: '{}' });
      assert.equal(res.status, 403, String(token));
    }
  });
  assert.deepEqual(events, []);
});

test('requests a web page could send are refused', async () => {
  const events = [];
  await withServer({ onEvent: (name) => events.push(name) }, async (port) => {
    const post = (headers) => request(port, { method: 'POST', path: '/claude-pet/hook/Stop', headers, body: '{}' });
    // simple content type, even with the token
    assert.equal((await post(hookHeaders(port, { 'content-type': 'text/plain' }))).status, 404);
    // fetch(..., { mode: 'no-cors', body: new Blob(['{}']) }) sends an Origin and no Content-Type
    for (const origin of ['https://evil.example', 'null']) {
      const headers = hookHeaders(port, { origin });
      delete headers['content-type'];
      assert.equal((await post(headers)).status, 404, origin);
      assert.equal((await post(hookHeaders(port, { origin }))).status, 404, origin);
    }
    // DNS rebinding: the page's own host name
    for (const host of ['evil.example', `evil.example:${port}`, '127.0.0.1', `127.0.0.1:${port + 1}`]) {
      assert.equal((await post(hookHeaders(port, { host }))).status, 404, host);
    }
  });
  assert.deepEqual(events, []);
});

test('the status endpoint needs the token and refuses pages too', async () => {
  const status = { petState: 'idle', activity: null };
  await withServer({ onStatus: () => status }, async (port) => {
    const get = (headers) => request(port, { path: '/claude-pet/status', headers });
    const ok = await get({ host: `127.0.0.1:${port}`, 'x-claude-pet-token': TOKEN });
    assert.equal(ok.status, 200);
    assert.deepEqual(JSON.parse(ok.body), status);
    assert.equal((await get({ host: `localhost:${port}` })).status, 403);
    assert.equal((await get({ host: `127.0.0.1:${port}`, 'x-claude-pet-token': 'guess' })).status, 403);
    assert.equal((await get({ host: `127.0.0.1:${port}`, 'x-claude-pet-token': TOKEN, origin: 'null' })).status, 404);
    assert.equal((await get({ host: `evil.example:${port}`, 'x-claude-pet-token': TOKEN })).status, 404);
  });
});

test('bodies that are not a JSON object arrive as an empty payload', async () => {
  const events = [];
  await withServer({ onEvent: (name, payload) => events.push(payload) }, async (port) => {
    for (const body of ['null', '[1]', '42', '"text"', '{ broken', '']) {
      const res = await request(port, { method: 'POST', path: '/claude-pet/hook/Stop', headers: hookHeaders(port), body });
      assert.equal(res.status, 200);
    }
  });
  assert.deepEqual(events, [{}, {}, {}, {}, {}, {}]);
});

test('a body over the size limit is still answered, and the fields the pet needs survive', async () => {
  const events = [];
  const big = 'x'.repeat(MAX_BODY + 200_000);
  const body = JSON.stringify({
    session_id: 's1',
    hook_event_name: 'PostToolUse',
    tool_name: 'Write',
    tool_input: { file_path: 'big.txt', content: big, session_id: 'not-this-one' },
    tool_response: { success: true },
    tool_use_id: 'toolu_01',
  });
  await withServer({ onEvent: (name, payload) => events.push([name, payload]) }, async (port) => {
    const res = await request(port, { method: 'POST', path: '/claude-pet/hook/PostToolUse', headers: hookHeaders(port), body });
    assert.equal(res.status, 200);
  });
  assert.deepEqual(events, [['PostToolUse', {
    session_id: 's1', hook_event_name: 'PostToolUse', tool_name: 'Write', tool_use_id: 'toolu_01',
  }]]);
});

test('fieldsFromPartialBody reads escaped values and ignores look-alikes inside tool input', () => {
  const head = '{"session_id":"a\\"b","tool_name":"Bash","tool_input":{"agent_id":"fake","command":"echo';
  const tail = 'still output","tool_use_id":"inside"},"tool_use_id":"toolu_9"}';
  assert.deepEqual(fieldsFromPartialBody(head, tail), { session_id: 'a"b', tool_name: 'Bash', tool_use_id: 'toolu_9' });
  assert.deepEqual(fieldsFromPartialBody('{"tool_inp', 'ut":1}'), {});
});

test('a throwing event or status handler is reported, and the request is still answered', async () => {
  const errors = [];
  const boom = () => { throw new Error('boom'); };
  await withServer({ onEvent: boom, onStatus: boom, onError: (err) => errors.push(err.message) }, async (port) => {
    const hook = await request(port, { method: 'POST', path: '/claude-pet/hook/Stop', headers: hookHeaders(port), body: '{}' });
    assert.equal(hook.status, 200);
    const status = await request(port, { path: '/claude-pet/status', headers: hookHeaders(port) });
    assert.equal(status.status, 500);
  });
  assert.deepEqual(errors, ['boom', 'boom']);
});

test('ready reports when another program already has the port', async () => {
  await withServer({}, async (port) => {
    const second = startHookServer({ port, token: TOKEN, onEvent: () => {} });
    const result = await second.ready;
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'EADDRINUSE');
    assert.equal(second.listening, false);
  });
});
