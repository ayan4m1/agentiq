import { test, describe, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { ChatRequest, Message } from 'ollama';

// escape is watched for on a real terminal, which a test does not have - so
// the watcher hands its callback over instead, for a test to press escape with
let pressEscape: (() => void) | undefined;
const stopWatching = mock.fn();
const watchForInterrupt = mock.fn((onInterrupt: () => void) => {
  pressEscape = onInterrupt;

  return stopWatching;
});

mock.module('./interrupt', { exports: { watchForInterrupt } });

// the spinner draws on a real terminal, which a test does not have
let spinning = false;

mock.module('ora', {
  exports: {
    default: () => ({
      start: () => (spinning = true),
      stop: () => (spinning = false),
      get isSpinning() {
        return spinning;
      },
      suffixText: ''
    })
  }
});

const { explore: config, ollama } = await import('./config');
const { explore, describeCall } = await import('./explore');
const { client } = await import('./client');
const { takeYield } = await import('./turn');

const chat = mock.method(
  client as unknown as { chat: (request: ChatRequest) => Promise<unknown> },
  'chat',
  async (): Promise<unknown> => {
    throw new Error('no response was set up for this test');
  }
);
const abortClient = mock.method(client, 'abort', () => {});
const requests = () =>
  chat.mock.calls.map((call) => call.arguments[0] as ChatRequest);

// answers each request with the next of these, in order
const answer = (...messages: Partial<Message>[]) => {
  let index = 0;

  chat.mock.mockImplementation(async () => ({
    message: {
      role: 'assistant',
      content: '',
      ...messages[Math.min(index++, messages.length - 1)]
    }
  }));
};

const call = (name: string, args: Record<string, unknown>) => ({
  tool_calls: [{ function: { name, arguments: args } }]
});

const original = process.cwd();
const defaults = { rounds: config.rounds, contextLimit: ollama.contextLimit };
let root: string;

beforeEach(() => {
  root = mkdtempSync(resolve(tmpdir(), 'agentiq-explore-'));
  process.chdir(root);
  writeFileSync(resolve(root, 'notes.txt'), 'the answer is 42\n');
  chat.mock.resetCalls();
  abortClient.mock.resetCalls();
  stopWatching.mock.resetCalls();
  pressEscape = undefined;
  takeYield();
});

afterEach(() => {
  process.chdir(original);
  rmSync(root, { recursive: true, force: true });
  config.rounds = defaults.rounds;
  ollama.contextLimit = defaults.contextLimit;
});

describe('explore', () => {
  test('offers only the read-only tools', async () => {
    answer({ content: 'nothing to see' });

    await explore('anything?');

    const names = requests()[0].tools?.map((tool) => tool.function.name);

    assert.deepEqual(names, ['find', 'list', 'read', 'fetch', 'read_plan']);
  });

  test('runs the calls it makes and returns only the report', async () => {
    answer(call('read', { path: 'notes.txt' }), {
      content: '  notes.txt:1 says the answer is 42  '
    });

    const report = await explore('what is the answer?');

    assert.equal(report, 'notes.txt:1 says the answer is 42');

    // the file's contents went to the explorer, not back to the caller
    const second = requests()[1].messages;
    const result = second.find((message) => message.role === 'tool');

    assert.equal(result?.tool_name, 'read');
    assert.match(result?.content ?? '', /the answer is 42/);
    assert.equal(second[1].content, 'what is the answer?');
  });

  test('cannot write, patch or run a command', async () => {
    answer(
      call('write', { path: 'evil.txt', content: 'oops' }),
      call('patch', { path: 'notes.txt', oldText: 'the', newText: 'a' }),
      call('shell', { command: 'echo hi > evil.txt', cwd: '.' }),
      { content: 'done' }
    );

    assert.equal(await explore('break something'), 'done');
    assert.ok(!existsSync(resolve(root, 'evil.txt')));

    const results = requests()
      .at(-1)!
      .messages.filter((message) => message.role === 'tool');

    assert.equal(results.length, 3);

    for (const result of results) {
      assert.match(
        result.content,
        /^There is no tool called \w+ while exploring/
      );
    }
  });

  test('asks for the report without tools once its rounds are used up', async () => {
    config.rounds = 2;
    chat.mock.mockImplementation(async (request: ChatRequest) => ({
      message: request.tools
        ? { role: 'assistant', content: '', ...call('list', {}) }
        : { role: 'assistant', content: 'ran out, here is what I have' }
    }));

    assert.equal(await explore('keep going'), 'ran out, here is what I have');

    const sent = requests();

    assert.equal(sent.length, 3);
    assert.equal(sent[2].tools, undefined);
    assert.match(
      sent[2].messages.at(-1)?.content ?? '',
      /used up your exploration budget/
    );
  });

  test('stops early once the conversation passes its token budget', async () => {
    ollama.contextLimit = 100;
    writeFileSync(resolve(root, 'big.txt'), 'x'.repeat(2000));
    chat.mock.mockImplementation(async (request: ChatRequest) => ({
      message: request.tools
        ? {
            role: 'assistant',
            content: '',
            ...call('read', { path: 'big.txt' })
          }
        : { role: 'assistant', content: 'summary' }
    }));

    assert.equal(await explore('read it all'), 'summary');
    // one round of reading, then straight to the report
    assert.equal(requests().length, 2);
  });

  test('runs a call the model wrote as text', async () => {
    answer(
      { content: '{"name": "read", "arguments": {"path": "notes.txt"}}' },
      { content: 'found it' }
    );

    assert.equal(await explore('what is in notes?'), 'found it');

    const result = requests()[1].messages.find(
      (message) => message.role === 'tool'
    );

    assert.match(result?.content ?? '', /the answer is 42/);
  });

  test('says so when the model reports nothing', async () => {
    answer({ content: '   ' });

    assert.equal(
      await explore('anything?'),
      'The exploration ended without a report.'
    );
  });

  test('escape ends the exploration and hands the keyboard back', async () => {
    chat.mock.mockImplementation(() => new Promise(() => {}));

    const pending = explore('this will take a while');

    // let the first request go out before pressing escape
    await new Promise((resolve) => setImmediate(resolve));
    pressEscape?.();

    assert.match(await pending, /The user interrupted the exploration/);
    assert.equal(abortClient.mock.callCount(), 1);
    assert.equal(stopWatching.mock.callCount(), 1);
    assert.equal(takeYield(), true);
  });
});

describe('describeCall', () => {
  test('names the tool and the values it was given', () => {
    assert.equal(
      describeCall('find', { pattern: '**/*.ts', content: 'approval' }),
      '  > find **/*.ts approval'
    );
  });

  test('leaves out values that were not given', () => {
    assert.equal(
      describeCall('read', { path: 'a.ts', offset: 10, limit: undefined }),
      '  > read a.ts 10'
    );
    assert.equal(describeCall('read_plan'), '  > read_plan');
  });
});
