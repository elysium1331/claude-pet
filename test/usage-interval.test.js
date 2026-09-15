const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const { UsageService, intervalMsFor, MIN_INTERVAL_MS } = require('../src/main/usage-service');

test('intervalMsFor never allows polling more than once a minute', () => {
  assert.equal(MIN_INTERVAL_MS, 60_000);
  assert.equal(intervalMsFor(2), 120_000);
  for (const bad of [0, -3, null, undefined, Number.NaN, 'fast', 0.1]) assert.equal(intervalMsFor(bad), 60_000, String(bad));
});

test('UsageService applies the minimum at construction and when the interval changes', () => {
  // no network: poll and schedule are stubbed, and the cache path doesn't exist
  const service = new UsageService({ cachePath: path.join(os.tmpdir(), 'claude-pet-no-such-cache.json'), intervalMinutes: 0 });
  let polls = 0;
  service.poll = () => { polls += 1; };
  service.schedule = () => {};
  assert.equal(service.intervalMs, 60_000);
  service.setIntervalMinutes(null);
  assert.equal(service.intervalMs, 60_000);
  assert.equal(polls, 0);
  service.setIntervalMinutes(10);
  assert.equal(service.intervalMs, 600_000);
  service.setIntervalMinutes(-1);
  assert.equal(service.intervalMs, 60_000);
  service.stop();
});
