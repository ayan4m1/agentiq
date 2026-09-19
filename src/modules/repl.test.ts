import { test, describe, before, beforeEach, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { mkdirSync, mkdtempSync } from 'node:fs';
import type { Message } from 'ollama';

import { ApprovalMode, type ThoughtState } from '../types';

// sessions are written under the home directory, which is read as the config
// module is evaluated - so it has to point somewhere disposable before any of
// the imports below. sessions are also keyed by working directory, so each
// test works in a project directory of its own
const root = mkdtempSync(resolve(tmpdir(), 'agentiq-repl-'));
const original = process.cwd();
let projects = 0;

process.env.AQ_HOME = resolve(root, 'home');

// /resume picks from a list in the terminal, so it picks what the test says to
const select =
  mock.fn<(config: { choices: { value: string }[] }) => Promise<string>>();

mock.module('@inquirer/prompts', {
  namedExports: { select, input: mock.fn() }
});

const { Command, createController } = await import('./repl');
const { approval } = await import('./approval');
const { yieldToUser, takeYield } = await import('./turn');
const { append, listSessions, loadSession, startSession } =
  await import('./session');

// the commands print, which is only noise here - but what they print is worth
// checking, so it is kept rather than dropped
const log = mock.method(console, 'log', () => {});
const printed = () =>
  log.mock.calls
    .map((call) => String(call.arguments[0].replaceAll(/\x1B\[[0-9;]*m/g, '')))
    .join('\n');

const toolCall = {
  message: {
    role: 'assistant',
    content: '',
    tool_calls: [{ function: { name: 'read', arguments: {} } }]
  }
};
const reply = { message: { role: 'assistant', content: 'done' } };

const makeThinker = () => ({
  tokens: { system: 10, tools: 20, messages: 0, total: 30, measured: false },
  turnCount: 0,
  load: mock.fn((messages: Message[]) => messages.length),
  reset: mock.fn(() => 0),
  compact: mock.fn(async (messages: Message[]) => ({ messages, freed: 0 })),
  think: mock.fn(
    async (thought: ThoughtState): Promise<ThoughtState> => thought
  )
});

let thinker: ReturnType<typeof makeThinker>;

const make = (compactAt = 1000) =>
  // the fake covers what the controller uses, not every field of a thinker
  createController({ thinker: thinker as never, compactAt });

// the model's answer to the next turn, added to what it was sent
const answers = (response: { message: object }) =>
  thinker.think.mock.mockImplementationOnce(async (thought) => ({
    ...thought,
    messages: [...thought.messages, response.message as Message],
    lastResponse: response as ThoughtState['lastResponse']
  }));

const saved = () => loadSession(listSessions(1)[0].id) ?? [];

before(() => {
  mkdirSync(process.env.AQ_HOME!, { recursive: true });
});

beforeEach(() => {
  const project = resolve(root, `project-${projects++}`);

  mkdirSync(project);
  process.chdir(project);
  startSession();

  thinker = makeThinker();
  approval.mode = ApprovalMode.Manual;
  log.mock.resetCalls();
  select.mock.resetCalls();
  takeYield();
});

after(() => {
  process.chdir(original);
});

describe('turns', () => {
  test('waits for the user before anything else', () => {
    const controller = make();

    assert.equal(controller.needsUserInput, true);
    assert.deepEqual(controller.messages, []);
  });

  test('hands a typed message to the model', () => {
    const controller = make();

    controller.addUserMessage('hello');

    assert.deepEqual(controller.messages, [{ role: 'user', content: 'hello' }]);
    assert.equal(controller.needsUserInput, false);
  });

  test('hands back to the user once the model stops calling tools', async () => {
    const controller = make();

    controller.addUserMessage('hello');
    answers(reply);
    await controller.takeTurn();

    assert.equal(controller.needsUserInput, true);
    assert.equal(controller.messages.at(-1)?.content, 'done');
  });

  test('keeps going while the model is calling tools', async () => {
    const controller = make();

    controller.addUserMessage('hello');
    answers(toolCall);
    await controller.takeTurn();

    assert.equal(controller.needsUserInput, false);
  });

  test('hands back to the user when a tool asked it to', async () => {
    const controller = make();

    controller.addUserMessage('hello');
    thinker.think.mock.mockImplementationOnce(async (thought) => {
      yieldToUser();

      return { ...thought, lastResponse: toolCall as never };
    });
    await controller.takeTurn();

    assert.equal(controller.needsUserInput, true);
  });

  test('runs each turn through the schedule it is given', async () => {
    const controller = make();
    const schedule = mock.fn((work: () => Promise<ThoughtState>) => work());

    controller.addUserMessage('hello');
    answers(reply);
    await controller.takeTurn(schedule);

    assert.equal(schedule.mock.callCount(), 1);
  });

  test('writes the conversation to the session after a turn', async () => {
    const controller = make();

    controller.addUserMessage('hello');
    answers(reply);
    await controller.takeTurn();

    assert.deepEqual(
      saved().map((message) => message.content),
      ['hello', 'done']
    );
  });

  test('keeps the conversation when the model call fails', async () => {
    const controller = make();

    controller.addUserMessage('hello');
    thinker.think.mock.mockImplementationOnce(async () => {
      throw new Error('connection refused');
    });
    await controller.takeTurn();

    assert.equal(controller.needsUserInput, true);
    assert.deepEqual(controller.messages, [{ role: 'user', content: 'hello' }]);
    // the message is still saved, to be picked up by the next attempt
    assert.equal(saved().length, 1);
  });

  test('hands back to the user after an interruption', async () => {
    const controller = make(0);

    controller.addUserMessage('hello');
    thinker.think.mock.mockImplementationOnce(async (thought) => ({
      ...thought,
      interrupted: true
    }));
    await controller.takeTurn();

    assert.equal(controller.needsUserInput, true);
    // an interrupted turn is not the moment to start summarizing
    assert.equal(thinker.compact.mock.callCount(), 0);
  });
});

describe('compaction', () => {
  test('compacts once the context passes the threshold', async () => {
    const controller = make(25);

    controller.addUserMessage('hello');
    answers(reply);
    await controller.takeTurn();

    assert.equal(thinker.compact.mock.callCount(), 1);
  });

  test('leaves the context alone below the threshold', async () => {
    const controller = make(1000);

    controller.addUserMessage('hello');
    answers(reply);
    await controller.takeTurn();

    assert.equal(thinker.compact.mock.callCount(), 0);
  });

  test('stops trying after a compaction that freed nothing', async () => {
    const controller = make(25);

    controller.addUserMessage('hello');
    answers(toolCall);
    await controller.takeTurn();
    answers(reply);
    await controller.takeTurn();

    assert.equal(controller.compactionStalled, true);
    assert.equal(thinker.compact.mock.callCount(), 1);
  });

  test('keeps compacting while it frees something', async () => {
    const controller = make(25);

    thinker.compact.mock.mockImplementation(async (messages) => ({
      messages,
      freed: 5
    }));
    controller.addUserMessage('hello');
    answers(toolCall);
    await controller.takeTurn();
    answers(reply);
    await controller.takeTurn();

    assert.equal(controller.compactionStalled, false);
    assert.equal(thinker.compact.mock.callCount(), 2);
  });

  test('rewrites the session with what compaction kept', async () => {
    const controller = make();
    const summary: Message = { role: 'user', content: 'summary' };

    controller.addUserMessage('hello');
    thinker.compact.mock.mockImplementationOnce(async () => ({
      messages: [summary],
      freed: 5
    }));
    await controller.compact();

    assert.deepEqual(controller.messages, [summary]);
    assert.deepEqual(saved(), [summary]);
  });

  test('tries again when asked to, even after stalling', async () => {
    const controller = make(25);

    controller.addUserMessage('hello');
    answers(reply);
    await controller.takeTurn();
    assert.equal(controller.compactionStalled, true);

    thinker.compact.mock.mockImplementationOnce(async (messages) => ({
      messages,
      freed: 5
    }));
    await controller.runCommand(Command.Compact);

    assert.equal(thinker.compact.mock.callCount(), 2);
    assert.equal(controller.compactionStalled, false);
  });
});

describe('restore', () => {
  test('fails when there is nothing to resume', () => {
    assert.equal(make().restore(), false);
  });

  test('fails for a session that does not exist', () => {
    assert.equal(make().restore('no-such-session'), false);
  });

  test('picks up the most recent session', () => {
    const messages: Message[] = [
      { role: 'user', content: 'earlier' },
      { role: 'assistant', content: 'reply' }
    ];

    append(messages);

    const controller = make();

    assert.equal(controller.restore(), true);
    assert.deepEqual(controller.messages, messages);
    assert.deepEqual(thinker.load.mock.calls[0].arguments[0], messages);
    assert.equal(controller.needsUserInput, true);
  });

  test('picks up a session by id', () => {
    const id = startSession();

    append([{ role: 'user', content: 'by id' }]);
    startSession();

    const controller = make();

    assert.equal(controller.restore(id), true);
    assert.equal(controller.messages[0].content, 'by id');
  });
});

describe('commands', () => {
  test('lists every command for /help', async () => {
    await make().runCommand(Command.Help);

    for (const name of Object.values(Command)) {
      assert.match(printed(), new RegExp(`/${name}\\b`));
    }
  });

  test('leaves quitting to the caller', async () => {
    assert.equal(await make().runCommand(Command.Quit), Command.Quit);
  });

  test('carries on after an unknown command', async () => {
    assert.equal(await make().runCommand('nonsense'), undefined);
  });

  test('cycles the approval mode for /mode', async () => {
    await make().runCommand(Command.Mode);

    assert.equal(approval.mode, ApprovalMode.Auto);
  });

  test('shows how the context is spent for /context', async () => {
    await make().runCommand(Command.Context);

    assert.match(printed(), /\{SYSTEM {3}\} - 10 tokens/);
    assert.match(printed(), /\{TOOLS {4}\} - 20 tokens/);
    assert.match(printed(), /\{MESSAGES \} - 0 tokens/);
    assert.match(printed(), /\{TOTAL {4}\} - 30 tokens/);
  });

  test('drops the conversation for /clear and starts a new session', async () => {
    const controller = make();

    controller.addUserMessage('hello');
    answers(reply);
    await controller.takeTurn();
    await controller.runCommand(Command.Clear);

    assert.deepEqual(controller.messages, []);
    assert.equal(thinker.reset.mock.callCount(), 1);

    // the old conversation is kept, and what comes next goes somewhere new
    controller.addUserMessage('again');
    answers(reply);
    await controller.takeTurn();

    assert.equal(listSessions().length, 2);
  });

  test('treats /reset the same as /clear', async () => {
    const controller = make();

    controller.addUserMessage('hello');
    await controller.runCommand(Command.Reset);

    assert.deepEqual(controller.messages, []);
    assert.equal(thinker.reset.mock.callCount(), 1);
  });

  test('offers the saved sessions for /resume', async () => {
    const id = startSession();

    append([{ role: 'user', content: 'chosen' }]);
    select.mock.mockImplementationOnce(async () => id);

    const controller = make();

    await controller.runCommand(Command.Resume);

    assert.deepEqual(
      select.mock.calls[0].arguments[0].choices.map((choice) => choice.value),
      [id]
    );
    assert.equal(controller.messages[0].content, 'chosen');
  });

  test('keeps the conversation when /resume is cancelled', async () => {
    append([{ role: 'user', content: 'saved' }]);
    select.mock.mockImplementationOnce(async () => {
      throw new Error('User force closed the prompt');
    });

    const controller = make();

    controller.addUserMessage('current');
    await controller.runCommand(Command.Resume);

    assert.equal(controller.messages[0].content, 'current');
  });

  test('does not ask which session when there are none', async () => {
    await make().runCommand(Command.Resume);

    assert.equal(select.mock.callCount(), 0);
  });

  test('reports on the files written for /changes and /undo', async () => {
    const controller = make();

    await controller.runCommand(Command.Changes);
    await controller.runCommand(Command.Undo);

    assert.match(printed(), /Nothing has been written this session/);
    assert.match(printed(), /There is nothing to undo/);
  });
});
