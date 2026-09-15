const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { logStrayErrors, startGuarded, guarded } = require('../src/main/error-guard');

test('logStrayErrors logs uncaught exceptions and rejections instead of letting them crash or block', () => {
  const proc = new EventEmitter();
  const logged = [];
  logStrayErrors(proc, (context, err) => logged.push([context, err.message]));
  assert.doesNotThrow(() => proc.emit('uncaughtException', new Error('boom')));
  proc.emit('unhandledRejection', new Error('nope'));
  assert.deepEqual(logged, [['uncaught exception', 'boom'], ['unhandled promise rejection', 'nope']]);
});

test('startGuarded hands any startup throw or rejection to the failure handler', async () => {
  const failures = [];
  const onFailure = (err) => failures.push(err.message);
  await startGuarded(Promise.resolve(), () => {
    throw new Error('bad pet.json');
  }, onFailure);
  await startGuarded(Promise.resolve(), async () => {
    throw new Error('late failure');
  }, onFailure);
  await startGuarded(Promise.reject(new Error('never ready')), () => failures.push('started'), onFailure);
  let started = false;
  await startGuarded(Promise.resolve(), () => { started = true; }, onFailure);
  assert.deepEqual(failures, ['bad pet.json', 'late failure', 'never ready']);
  assert.equal(started, true);
});

test('guarded keeps a throwing timer callback from escaping, and passes results through', () => {
  const logged = [];
  const log = (context, err) => logged.push([context, err.message]);
  assert.equal(guarded(log, 'tick', () => { throw new Error('bad value'); })(), undefined);
  assert.equal(guarded(log, 'sum', (a, b) => a + b)(2, 3), 5);
  assert.deepEqual(logged, [['tick', 'bad value']]);
});
