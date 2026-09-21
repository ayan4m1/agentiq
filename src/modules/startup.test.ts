import { test, describe, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

// every step of starting up talks to the server, the disk or the terminal, so
// each is replaced by one that does whatever the test says to
let entryResolves = true;
let preflightPasses = true;

const resolveStartupEntry = mock.fn(async () => entryResolves);
const preflight = mock.fn(async () => preflightPasses);
const ensureTokenizer = mock.fn(async () => true);
const thinker = { tokens: {} };
const makeThinker = mock.fn(() => thinker);
const killAllJobs = mock.fn();
const discardCheckpoints = mock.fn();

mock.module('./models', { namedExports: { resolveStartupEntry } });
mock.module('./preflight', { namedExports: { preflight } });
mock.module('./tokenizer', { namedExports: { ensureTokenizer } });
mock.module('./ollama', { namedExports: { makeThinker } });
mock.module('./jobs', { namedExports: { killAllJobs } });
mock.module('./checkpoints', { namedExports: { discardCheckpoints } });

const { startAgent } = await import('./startup');

// startAgent hooks the process itself, and those hooks must not outlive the
// test that added them - the SIGINT one would end the test run
type Listener = (...args: unknown[]) => void;

let exitListeners: Listener[];
let sigintListeners: Listener[];

beforeEach(() => {
  entryResolves = true;
  preflightPasses = true;
  exitListeners = process.listeners('exit') as Listener[];
  sigintListeners = process.listeners('SIGINT') as Listener[];

  for (const fn of [
    resolveStartupEntry,
    preflight,
    ensureTokenizer,
    makeThinker,
    killAllJobs,
    discardCheckpoints
  ]) {
    fn.mock.resetCalls();
  }
});

const added = (event: 'exit' | 'SIGINT', before: Listener[]) =>
  (process.listeners(event) as Listener[]).filter(
    (listener) => !before.includes(listener)
  );

afterEach(() => {
  for (const listener of added('exit', exitListeners)) {
    process.off('exit', listener);
  }

  for (const listener of added('SIGINT', sigintListeners)) {
    process.off('SIGINT', listener);
  }
});

describe('startAgent', () => {
  test('stops when no model could be chosen', async () => {
    entryResolves = false;

    assert.equal(await startAgent(), undefined);
    assert.equal(preflight.mock.callCount(), 0);
  });

  test('stops before the tokenizer download when preflight fails', async () => {
    preflightPasses = false;

    assert.equal(await startAgent(), undefined);
    assert.equal(ensureTokenizer.mock.callCount(), 0);
    assert.equal(makeThinker.mock.callCount(), 0);
  });

  test('makes the thinker once everything it needs is in place', async () => {
    const agent = await startAgent();

    assert.equal(agent?.thinker, thinker);
    assert.equal(ensureTokenizer.mock.callCount(), 1);
  });

  test('schedules work and hands back its result', async () => {
    const agent = await startAgent();
    const result = await agent!.schedule(async () => ({ messages: [] }));

    assert.deepEqual(result, { messages: [] });
  });

  test('cleans up jobs and checkpoints', async () => {
    const agent = await startAgent();

    agent!.cleanUp();

    assert.equal(killAllJobs.mock.callCount(), 1);
    assert.equal(discardCheckpoints.mock.callCount(), 1);
  });

  test('cleans up on the way out of the process', async () => {
    await startAgent();

    const [onExit] = added('exit', exitListeners);

    onExit();

    assert.equal(killAllJobs.mock.callCount(), 1);
  });

  test('cleans up and exits when interrupted', async () => {
    await startAgent();

    const exit = mock.method(process, 'exit', () => undefined as never);

    try {
      const [onSigint] = added('SIGINT', sigintListeners);

      onSigint();

      assert.equal(discardCheckpoints.mock.callCount(), 1);
      assert.equal(exit.mock.calls[0].arguments[0], 130);
    } finally {
      exit.mock.restore();
    }
  });
});
