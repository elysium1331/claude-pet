const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { startHookServer } = require('../src/main/hook-server');

function request(port, { method = 'GET', path, headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function withServer(options, run) {
  const server = startHookServer({ port: 0, ...options });
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    await run(server.address().port);
  } finally {
    server.close();
  }
}

test('hook events are delivered and answered with an empty JSON object', async () => {
  const events = [];
  await withServer({ onEvent: (name, payload) => events.push([name, payload]) }, async (port) => {
    const res = await request(port, {
      method: 'POST',
      path: '/claude-pet/hook/Stop',
      headers: { 'content-type': 'application/json', host: `127.0.0.1:${port}` },
      body: JSON.stringify({ session_id: 'abc' }),
    });
    assert.equal(res.status, 200);
    assert.equal(res.body, '{}');
  });
  assert.deepEqual(events, [['Stop', { session_id: 'abc' }]]);
});

test('requests a web page could send are refused', async () => {
  const events = [];
  await withServer({ onEvent: (name) => events.push(name) }, async (port) => {
    const res = await request(port, {
      method: 'POST',
      path: '/claude-pet/hook/Stop',
      headers: { 'content-type': 'text/plain', host: `127.0.0.1:${port}` },
      body: '{}',
    });
    assert.equal(res.status, 404);
  });
  assert.deepEqual(events, []);
});

test('the status endpoint reports what the pet thinks is going on', async () => {
  await withServer({ onEvent: () => {}, onStatus: () => ({ petState: 'idle', activity: null }) }, async (port) => {
    const res = await request(port, { path: '/claude-pet/status', headers: { host: `127.0.0.1:${port}` } });
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body), { petState: 'idle', activity: null });
  });
});
