import { test, describe, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

import { fakePreflight } from '../../test/fakes/preflight';
import type { ModuleMock } from '../../test/fakes/module';

// every step of starting up talks to the server, the disk or the terminal, so
// each is replaced by one that does whatever the test says to
let entryResolves = true;
let preflightPasses = true;

const resolveStartupEntry = mock.fn(async () => entryResolves);
const preflight = mock.fn(async () => preflightPasses);
const ensureTokenizer = mock.fn(async () => true);
let hfTokenizer = true;
const usesHfTokenizer = () => hfTokenizer;
const providerConfig = {
  name: 'ollama',
  model: 'test-model',
  minTurnDelay: 0
};
const count = mock.fn(async () => {});
const thinker = { tokens: {}, count };
const makeThinker = mock.fn(() => thinker);
const killAllJobs = mock.fn();
const discardCheckpoints = mock.fn();
const info = mock.fn();
const mcpTools = [{ definition: { type: 'function', function: {} } }];
const connectServers = mock.fn(async () => mcpTools);
const closeServers = mock.fn();
// whether the tools were registered by the time the thinker was made
let registeredBeforeThinker = false;
const registerTools = mock.fn();

makeThinker.mock.mockImplementation(() => {
  registeredBeforeThinker = registerTools.mock.callCount() > 0;

  return thinker;
});

mock.module('./logging', {
  exports: { getLogger: () => ({ info }) } satisfies ModuleMock<
    typeof import('./logging')
  >
});
mock.module('./config', {
  exports: {
    ollama: {
      host: 'http://example:11434'
    },
    provider: providerConfig
  } as ModuleMock<typeof import('./config')>
});
mock.module('./skills', {
  exports: { loadSkills: () => [] } satisfies ModuleMock<
    typeof import('./skills')
  >
});
mock.module('./models', {
  exports: { resolveStartupEntry } satisfies ModuleMock<
    typeof import('./models')
  >
});
mock.module('./preflight', {
  exports: fakePreflight({ preflight }).exports
});
mock.module('./tokenizer', {
  exports: { ensureTokenizer, usesHfTokenizer } satisfies ModuleMock<
    typeof import('./tokenizer')
  >
});
mock.module('../providers', {
  exports: {
    chatProvider: { label: 'Anthropic API' }
  } as ModuleMock<typeof import('../providers')>
});
mock.module('./thinker', {
  exports: { makeThinker } satisfies ModuleMock<typeof import('./thinker')>
});
mock.module('./jobs', {
  exports: { killAllJobs } satisfies ModuleMock<typeof import('./jobs')>
});
mock.module('./checkpoints', {
  exports: { discardCheckpoints } satisfies ModuleMock<
    typeof import('./checkpoints')
  >
});

mock.module('./mcp', {
  exports: { connectServers, closeServers } as ModuleMock<
    typeof import('./mcp')
  >
});
mock.module('../tools', {
  exports: { registerTools } as ModuleMock<typeof import('../tools')>
});

const { startAgent } = await import('./startup');

// startAgent hooks the process itself, and those hooks must not outlive the
// test that added them - the SIGINT one would end the test run
type Listener = (...args: unknown[]) => void;

let exitListeners: Listener[];
let sigintListeners: Listener[];

beforeEach(() => {
  entryResolves = true;
  preflightPasses = true;
  hfTokenizer = true;
  providerConfig.name = 'ollama';
  exitListeners = process.listeners('exit') as Listener[];
  sigintListeners = process.listeners('SIGINT') as Listener[];

  for (const fn of [
    resolveStartupEntry,
    preflight,
    ensureTokenizer,
    makeThinker,
    count,
    killAllJobs,
    discardCheckpoints,
    info,
    connectServers,
    closeServers,
    registerTools
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
    assert.equal(info.mock.callCount(), 0);
  });

  test('says which server and model it connected to', async () => {
    await startAgent();

    assert.equal(info.mock.callCount(), 1);
    assert.equal(
      info.mock.calls[0].arguments[0],
      'Connected to ollama server http://example:11434 using model test-model'
    );
  });

  test('makes the thinker once everything it needs is in place', async () => {
    const agent = await startAgent();

    assert.equal(agent?.thinker, thinker);
    assert.equal(ensureTokenizer.mock.callCount(), 1);
  });

  test('registers the MCP tools before making the thinker', async () => {
    registeredBeforeThinker = false;

    await startAgent();

    assert.equal(connectServers.mock.callCount(), 1);
    assert.deepEqual(registerTools.mock.calls[0].arguments, [mcpTools]);
    assert.equal(registeredBeforeThinker, true);
  });

  test('counts the empty conversation before the first turn', async () => {
    await startAgent();

    assert.equal(count.mock.callCount(), 1);
    assert.deepEqual(count.mock.calls[0].arguments, [[]]);
  });

  test('fetches no tokenizer for a provider that counts for itself', async () => {
    hfTokenizer = false;
    providerConfig.name = 'anthropic';

    await startAgent();

    assert.equal(ensureTokenizer.mock.callCount(), 0);
    assert.equal(makeThinker.mock.callCount(), 1);
    assert.equal(
      info.mock.calls[0].arguments[0],
      'Connected to Anthropic API using model test-model'
    );
  });

  test('schedules work and hands back its result', async () => {
    const agent = await startAgent();
    const result = await agent!.schedule(async () => ({ messages: [] }));

    assert.deepEqual(result, { messages: [] });
  });

  test('cleans up jobs, MCP servers and checkpoints', async () => {
    const agent = await startAgent();

    agent!.cleanUp();

    assert.equal(killAllJobs.mock.callCount(), 1);
    assert.equal(closeServers.mock.callCount(), 1);
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
