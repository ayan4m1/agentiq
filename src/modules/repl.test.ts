import { test, describe, before, beforeEach, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync
} from 'node:fs';
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
// the cap is read as the config module is evaluated, so it has to be set here
// too. a small one keeps the test that checks it short, and every other test
// stays well under it
process.env.AQ_HISTORY_LIMIT = '3';

// /resume picks from a list in the terminal, so it picks what the test says to
const select =
  mock.fn<(config: { choices: { value: string }[] }) => Promise<string>>();

// /undo asks before it throws anything away, and says yes unless told not to
const confirm = mock.fn<(config: { message: string }) => Promise<boolean>>(
  async () => true
);

// /paste opens the user's editor, which here hands back whatever the test says
const editor = mock.fn<(config: unknown) => Promise<string>>();

mock.module('@inquirer/prompts', {
  namedExports: { select, confirm, editor, input: mock.fn() }
});

// /model asks the server whether the model it was given is really there, and
// downloads a tokenizer for it - neither of which belongs in a unit test
let preflightPasses = true;

const preflight = mock.fn(async () => preflightPasses);

// what the model says it can hold, for /context-limit to warn against
let contextLength: number | undefined;
const ensureTokenizer = mock.fn(async () => true);

// /model picks from a prompt of its own
const pickModel = mock.fn<(config: unknown) => Promise<string>>();

mock.module('./picker', { namedExports: { pickModel } });

mock.module('./preflight', {
  // listModels is what modules/models.ts reaches for, and nothing here gets as
  // far as the add flow that would call it
  namedExports: {
    preflight,
    listModels: async () => [],
    matchesModel: (installed: string, configured: string) =>
      installed === configured,
    supportsThinking: () => false,
    modelContextLength: () => contextLength
  }
});
mock.module('./tokenizer', {
  namedExports: {
    ensureTokenizer,
    estimateTokens: (value: string) => value.length,
    makeTokenizer: () => (value: string) => value.length
  }
});

const { Command, createController } = await import('./repl');
const { approval } = await import('./approval');
const { ollama, session, tokenizer } = await import('./config');
const { loadStore, saveStore } = await import('./models');
const { yieldToUser, takeYield } = await import('./turn');
const { append, listSessions, loadSession, startSession } =
  await import('./session');
const { discardCheckpoints, record } = await import('./checkpoints');
const { getLogger } = await import('./logging');

// the commands print, which is only noise here - but what they print is worth
// checking, so it is kept rather than dropped
const log = mock.method(console, 'log', () => {});
const printed = () =>
  log.mock.calls
    // strip ANSI colors
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
  tokens: {
    system: 10,
    skills: 5,
    tools: 20,
    messages: 0,
    total: 35,
    measured: false
  },
  turnCount: 0,
  load: mock.fn((messages: Message[]) => messages.length),
  reset: mock.fn(() => 0),
  rebuild: mock.fn((messages: Message[]) => messages.length),
  compact: mock.fn(async (messages: Message[]) => ({ messages, freed: 0 })),
  recap: mock.fn<
    (messages: Message[], turns?: number) => Promise<string | undefined>
  >(async () => undefined),
  think: mock.fn(
    async (thought: ThoughtState): Promise<ThoughtState> => thought
  )
});

let thinker: ReturnType<typeof makeThinker>;

const make = (
  compactAt = 1000,
  rememberPrompts?: (prompts: string[]) => void
) =>
  // the fake covers what the controller uses, not every field of a thinker
  createController({
    thinker: thinker as never,
    compactAt: () => compactAt,
    rememberPrompts
  });

// what a restore handed to the prompt, for the tests that care
const seeded = () => {
  const remember = mock.fn<(prompts: string[]) => void>();

  return { remember, prompts: () => remember.mock.calls[0]?.arguments[0] };
};

// the model's answer to the next turn, added to what it was sent
const answers = (response: { message: object }) =>
  thinker.think.mock.mockImplementationOnce(async (thought) => ({
    ...thought,
    messages: [...thought.messages, response.message as Message],
    lastResponse: response as ThoughtState['lastResponse']
  }));

// the model's answers to the next few turns, in order - answers() only ever
// covers the very next call
const answersInOrder = (...responses: { message: object }[]) => {
  for (const [index, response] of responses.entries()) {
    thinker.think.mock.mockImplementationOnce(
      async (thought) => ({
        ...thought,
        messages: [...thought.messages, response.message as Message],
        lastResponse: response as ThoughtState['lastResponse']
      }),
      thinker.think.mock.callCount() + index
    );
  }
};

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
  preflightPasses = true;
  contextLength = undefined;
  ollama.contextLimit = 4096;
  preflight.mock.resetCalls();
  ensureTokenizer.mock.resetCalls();
  log.mock.resetCalls();
  select.mock.resetCalls();
  pickModel.mock.resetCalls();
  confirm.mock.resetCalls();
  editor.mock.resetCalls();
  discardCheckpoints();
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

  test('reports a failed model call until the next turn', async () => {
    const controller = make();

    controller.addUserMessage('hello');
    thinker.think.mock.mockImplementationOnce(async () => {
      throw new Error('connection refused');
    });
    await controller.takeTurn();

    assert.equal(controller.failed, true);

    answers(reply);
    await controller.takeTurn();

    assert.equal(controller.failed, false);
  });
});

describe('@ mentions', () => {
  test('attaches a mentioned file as the read tool would return it', () => {
    const controller = make();

    writeFileSync('notes.txt', 'alpha\nbeta');
    controller.addUserMessage('summarize @notes.txt please');

    assert.deepEqual(controller.messages, [
      {
        role: 'user',
        content:
          'summarize @notes.txt please\n\nContents of notes.txt:\n     1\talpha\n     2\tbeta',
        typed: 'summarize @notes.txt please'
      }
    ]);
  });

  test('attaches each file once, in the order they were mentioned', () => {
    const controller = make();

    mkdirSync('src');
    writeFileSync('src/a.ts', 'a');
    writeFileSync('b.ts', 'b');
    controller.addUserMessage('@src/a.ts and @b.ts, then @src/a.ts again');

    const { content } = controller.messages[0];

    assert.equal(content.match(/Contents of/g)?.length, 2);
    assert.ok(
      content.indexOf('Contents of src/a.ts') <
        content.indexOf('Contents of b.ts')
    );
  });

  test('leaves missing paths, directories and email addresses as typed', () => {
    const controller = make();

    mkdirSync('folder');
    writeFileSync('user', 'not a mention');
    controller.addUserMessage(
      'ask user@example.com about @missing.ts or @folder.'
    );

    assert.deepEqual(controller.messages, [
      {
        role: 'user',
        content: 'ask user@example.com about @missing.ts or @folder.'
      }
    ]);
  });

  test('offers the typed prompt back to /undo, not the attachment', async () => {
    const controller = make();

    writeFileSync('notes.txt', 'alpha');
    controller.addUserMessage('read @notes.txt');
    answers(reply);
    await controller.takeTurn();

    select.mock.mockImplementationOnce(async () => 0 as never);
    await controller.runCommand(Command.Undo);

    const { choices } = select.mock.calls[0].arguments[0] as unknown as {
      choices: { name: string }[];
    };

    assert.match(choices[0].name, /^read @notes\.txt /);
    assert.equal(controller.takePrefill(), 'read @notes.txt');
  });

  test('seeds the history of a resumed session with the typed prompt', () => {
    append([
      {
        role: 'user',
        content: 'read @notes.txt\n\nContents of notes.txt:\n     1\talpha',
        typed: 'read @notes.txt'
      } as Message
    ]);

    const { remember, prompts } = seeded();

    make(1000, remember).restore();

    assert.deepEqual(prompts(), ['read @notes.txt']);
  });
});

describe('runPrompt', () => {
  test('keeps taking turns until the model stops calling tools', async () => {
    const controller = make();

    answersInOrder(toolCall, toolCall, reply);

    assert.equal(await controller.runPrompt('hello'), true);
    assert.equal(thinker.think.mock.callCount(), 3);
    assert.equal(controller.needsUserInput, true);
    assert.equal(controller.messages.at(-1)?.content, 'done');
  });

  test('stops when a tool hands the conversation back', async () => {
    const controller = make();

    thinker.think.mock.mockImplementationOnce(async (thought) => {
      yieldToUser();

      return { ...thought, lastResponse: toolCall as never };
    });

    assert.equal(await controller.runPrompt('hello'), true);
    assert.equal(thinker.think.mock.callCount(), 1);
  });

  test('runs every turn through the schedule it is given', async () => {
    const controller = make();
    const schedule = mock.fn((work: () => Promise<ThoughtState>) => work());

    answersInOrder(toolCall, reply);
    await controller.runPrompt('hello', schedule);

    assert.equal(schedule.mock.callCount(), 2);
  });

  test('writes the prompt and the replies to the session', async () => {
    const controller = make();

    answers(reply);
    await controller.runPrompt('hello');

    assert.deepEqual(
      saved().map((message) => message.content),
      ['hello', 'done']
    );
  });

  test('reports a failed model call', async () => {
    const controller = make();

    thinker.think.mock.mockImplementationOnce(async () => {
      throw new Error('connection refused');
    });

    assert.equal(await controller.runPrompt('hello'), false);
    // the prompt is still saved, so the session can be resumed and retried
    assert.equal(saved().length, 1);
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

  test('does not recap on its own', async () => {
    const controller = make();

    controller.addUserMessage('hello');
    thinker.compact.mock.mockImplementationOnce(async (messages) => ({
      messages,
      freed: 5
    }));
    await controller.compact();

    assert.equal(thinker.recap.mock.callCount(), 0);
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

  test('offers back what the user typed, oldest first', () => {
    append([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply' },
      { role: 'tool', tool_name: 'read', content: 'file contents' },
      { role: 'user', content: 'second' }
    ]);

    const { remember, prompts } = seeded();

    assert.equal(make(1000, remember).restore(), true);
    assert.deepEqual(prompts(), ['first', 'second']);
  });

  test('leaves out the notes compaction wrote', () => {
    append([
      { role: 'user', content: 'typed' },
      // deliberately one line: a multi-line fixture would be dropped by the
      // check below it, and this would pass without the flag being read at all
      { role: 'user', content: 'what happened earlier', summary: true }
    ]);

    const { remember, prompts } = seeded();

    assert.equal(make(1000, remember).restore(), true);
    assert.deepEqual(prompts(), ['typed']);
  });

  test('leaves out blank and multi-line prompts', () => {
    append([
      { role: 'user', content: '   ' },
      { role: 'user', content: 'pasted\nover two lines' },
      { role: 'user', content: 'typed' }
    ]);

    const { remember, prompts } = seeded();

    assert.equal(make(1000, remember).restore(), true);
    assert.deepEqual(prompts(), ['typed']);
  });

  test('offers back only the most recent prompts', () => {
    append(
      ['oldest', 'older', 'newer', 'newest'].map((content) => ({
        role: 'user',
        content
      }))
    );

    const { remember, prompts } = seeded();

    assert.equal(make(1000, remember).restore(), true);
    // AQ_HISTORY_LIMIT is 3 for this run
    assert.deepEqual(prompts(), ['older', 'newer', 'newest']);
  });

  test('does not recap on its own', () => {
    append([
      { role: 'user', content: 'earlier' },
      { role: 'assistant', content: 'the last reply' }
    ]);

    assert.equal(make().restore(), true);
    assert.equal(thinker.recap.mock.callCount(), 0);
  });

  test('offers nothing back when there is nothing to resume', () => {
    const { remember } = seeded();

    assert.equal(make(1000, remember).restore(), false);
    assert.equal(make(1000, remember).restore('no-such-session'), false);
    assert.equal(remember.mock.callCount(), 0);
  });
});

const gemma = { model: 'gemma4:e4b', tokenizer: 'google/gemma-4-E4B' };
const qwen = { model: 'qwen3:30b', tokenizer: 'Qwen/Qwen3-Coder-30B' };

// a session already running on one of two saved models, which is what /model
// is for - the store and the config have to agree before it is asked to switch
const onModel = (entry: typeof gemma) => {
  saveStore({ active: entry.model, models: [gemma, qwen] });
  ollama.model = entry.model;
  tokenizer.repo = entry.tokenizer;

  return make();
};

describe('/recap', () => {
  const conversation = (): Message[] => [
    { role: 'user', content: 'earlier' },
    { role: 'assistant', content: 'the last reply' }
  ];

  test('recaps the conversation over the configured turns', async () => {
    const messages = conversation();

    append(messages);

    const { remember, prompts } = seeded();
    const controller = make(1000, remember);

    controller.restore();
    thinker.recap.mock.mockImplementationOnce(
      async () => 'you were working on earlier'
    );
    await controller.runCommand(Command.Recap);

    assert.equal(thinker.recap.mock.callCount(), 1);
    assert.deepEqual(thinker.recap.mock.calls[0].arguments, [
      messages,
      session.recapTurns
    ]);
    // the recap is only printed - the model, the session file and the up
    // arrow never see it
    assert.deepEqual(controller.messages, messages);
    assert.deepEqual(saved(), messages);
    assert.deepEqual(prompts(), ['earlier']);
  });

  test('covers as many turns as it is asked to', async () => {
    const controller = make();

    controller.addUserMessage('hello');
    await controller.runCommand(`${Command.Recap} 5`);

    assert.equal(thinker.recap.mock.calls[0].arguments[1], 5);
  });

  test('refuses a count that is not a positive number', async () => {
    const controller = make();

    controller.addUserMessage('hello');
    await controller.runCommand(`${Command.Recap} abc`);
    await controller.runCommand(`${Command.Recap} 0`);

    assert.equal(thinker.recap.mock.callCount(), 0);
  });

  test('asks for nothing when there is nothing to recap', async () => {
    await make().runCommand(Command.Recap);

    assert.equal(thinker.recap.mock.callCount(), 0);
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
    assert.match(printed(), /\{SKILLS {3}\} - 5 tokens/);
    assert.match(printed(), /\{TOOLS {4}\} - 20 tokens/);
    assert.match(printed(), /\{MESSAGES \} - 0 tokens/);
    assert.match(printed(), /\{TOTAL {4}\} - 35 tokens/);
  });

  test('shows the context limit for /context-limit', async () => {
    contextLength = 8192;
    ollama.model = gemma.model;
    await make().runCommand(Command.ContextLimit);

    assert.match(printed(), /Context limit is 4096 tokens/);
    assert.match(printed(), /gemma4:e4b supports 8192/);
  });

  test('changes the context limit for /context-limit <value>', async () => {
    await make().runCommand(`${Command.ContextLimit} 8192`);

    assert.equal(ollama.contextLimit, 8192);
    assert.match(
      readFileSync(resolve(root, 'home', 'config.yml'), 'utf8'),
      /^ {2}contextLimit: 8192$/m
    );
  });

  test('keeps the context limit for a value that is not a token count', async () => {
    const controller = make();

    for (const value of ['abc', '0', '-5', '12.5']) {
      await controller.runCommand(`${Command.ContextLimit} ${value}`);
    }

    assert.equal(ollama.contextLimit, 4096);
  });

  test('allows a context limit past what the model supports', async () => {
    contextLength = 2048;
    await make().runCommand(`${Command.ContextLimit} 16384`);

    assert.equal(ollama.contextLimit, 16384);
  });

  test('compacts at once when the limit drops below the context', async () => {
    const controller = createController({
      thinker: thinker as never,
      compactAt: () => ollama.contextLimit / 2
    });

    await controller.runCommand(`${Command.ContextLimit} 1000`);
    assert.equal(thinker.compact.mock.callCount(), 0);

    // 35 tokens is past half of 60
    await controller.runCommand(`${Command.ContextLimit} 60`);
    assert.equal(thinker.compact.mock.callCount(), 1);
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

    const { remember, prompts } = seeded();
    const controller = make(1000, remember);

    await controller.runCommand(Command.Resume);

    assert.deepEqual(
      select.mock.calls[0].arguments[0].choices.map((choice) => choice.value),
      [id]
    );
    assert.equal(controller.messages[0].content, 'chosen');
    // the slash command reaches the prompt history the same way --resume does
    assert.deepEqual(prompts(), ['chosen']);
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

  test('switches to another saved model for /model', async () => {
    const controller = onModel(gemma);

    controller.addUserMessage('hello');
    pickModel.mock.mockImplementationOnce(async () => qwen.model);
    await controller.runCommand(Command.Model);

    assert.equal(ollama.model, qwen.model);
    assert.equal(tokenizer.repo, qwen.tokenizer);
    // the next run starts where this session ended up
    assert.equal(loadStore().active, qwen.model);
    // the conversation carries over, counted again by the new tokenizer
    assert.deepEqual(thinker.rebuild.mock.calls[0].arguments[0], [
      { role: 'user', content: 'hello' }
    ]);
    assert.deepEqual(controller.messages, [{ role: 'user', content: 'hello' }]);
  });

  test('stays where it was when the new model fails preflight', async () => {
    const controller = onModel(gemma);

    preflightPasses = false;
    pickModel.mock.mockImplementationOnce(async () => qwen.model);
    await controller.runCommand(Command.Model);

    assert.equal(ollama.model, gemma.model);
    assert.equal(tokenizer.repo, gemma.tokenizer);
    // a switch that did not happen must not decide what the next run starts on
    assert.equal(loadStore().active, gemma.model);
    assert.equal(thinker.rebuild.mock.callCount(), 0);
    assert.equal(ensureTokenizer.mock.callCount(), 0);
  });

  test('does nothing for /model on the model already in use', async () => {
    const controller = onModel(gemma);

    pickModel.mock.mockImplementationOnce(async () => gemma.model);
    await controller.runCommand(Command.Model);

    assert.equal(thinker.rebuild.mock.callCount(), 0);
    assert.equal(preflight.mock.callCount(), 0);
  });

  test('keeps the model when /model is cancelled', async () => {
    const controller = onModel(gemma);

    pickModel.mock.mockImplementationOnce(async () => {
      throw new Error('User force closed the prompt');
    });
    await controller.runCommand(Command.Model);

    assert.equal(ollama.model, gemma.model);
    assert.equal(thinker.rebuild.mock.callCount(), 0);
  });

  test('reports on the files written for /changes', async () => {
    await make().runCommand(Command.Changes);

    assert.match(printed(), /Nothing has been written this session/);
  });
});

describe('/undo', () => {
  const read = (name: string) => readFileSync(name).toString();

  // a turn in which the model writes the given files the way write and patch
  // do, then replies
  const writes = (files: Record<string, string>) =>
    thinker.think.mock.mockImplementationOnce(async (thought) => {
      for (const [name, contents] of Object.entries(files)) {
        record(name);
        writeFileSync(name, contents);
      }

      return {
        ...thought,
        messages: [...thought.messages, reply.message as Message],
        lastResponse: reply as ThoughtState['lastResponse']
      };
    });

  // picks the prompt at the given index in the conversation
  const picks = (index: number) =>
    select.mock.mockImplementationOnce(async () => index as never);

  test('takes back a turn, and every one after it, files and all', async () => {
    const controller = make();

    writeFileSync('a.txt', 'original');

    controller.addUserMessage('first');
    writes({ 'a.txt': 'turn one' });
    await controller.takeTurn();

    controller.addUserMessage('second');
    writes({ 'b.txt': 'created', 'a.txt': 'turn two' });
    await controller.takeTurn();

    assert.equal(controller.messages.length, 4);

    picks(2);
    await controller.runCommand(Command.Undo);

    assert.equal(read('a.txt'), 'turn one');
    assert.equal(existsSync('b.txt'), false);
    assert.deepEqual(
      controller.messages.map((message) => message.content),
      ['first', 'done']
    );
    assert.deepEqual(
      saved().map((message) => message.content),
      ['first', 'done']
    );
    assert.deepEqual(thinker.load.mock.calls.at(-1)?.arguments[0], [
      ...controller.messages
    ]);
    assert.equal(controller.needsUserInput, true);
    // handed back once, to be edited and sent again
    assert.equal(controller.takePrefill(), 'second');
    assert.equal(controller.takePrefill(), undefined);

    picks(0);
    await controller.runCommand(Command.Undo);

    assert.equal(read('a.txt'), 'original');
    assert.deepEqual(controller.messages, []);
  });

  test('offers the prompts newest first with what each would revert', async () => {
    const controller = make();

    controller.addUserMessage('first');
    writes({ 'a.txt': 'a' });
    await controller.takeTurn();
    controller.addUserMessage('second');
    answers(reply);
    await controller.takeTurn();

    select.mock.mockImplementationOnce(async () => {
      throw new Error('User force closed the prompt');
    });
    await controller.runCommand(Command.Undo);

    // the mock is typed for /resume, whose choices are session ids
    const { choices } = select.mock.calls[0].arguments[0] as unknown as {
      choices: { name: string; value: number }[];
    };

    assert.deepEqual(
      choices.map(({ value }) => value),
      [2, 0]
    );
    assert.match(choices[0].name, /second.*\(0 file change/);
    assert.match(choices[1].name, /first.*\(1 file change/);
    // cancelling the choice leaves everything alone
    assert.equal(controller.messages.length, 4);
    assert.equal(read('a.txt'), 'a');
  });

  test('warns that shell commands are not reversed, and stops if declined', async () => {
    const controller = make();

    controller.addUserMessage('first');
    writes({ 'a.txt': 'a' });
    await controller.takeTurn();

    picks(0);
    confirm.mock.mockImplementationOnce(async () => false);
    await controller.runCommand(Command.Undo);

    assert.match(confirm.mock.calls[0].arguments[0].message, /shell/);
    assert.equal(read('a.txt'), 'a');
    assert.equal(controller.messages.length, 2);
    assert.equal(controller.takePrefill(), undefined);
  });

  test('says so when there is no prompt to undo', async (t) => {
    // the controller logs through the 'run' logger, which getLogger caches -
    // so this is the very instance it warns through
    const warn = t.mock.method(getLogger('run'), 'warn', () => {});

    await make().runCommand(Command.Undo);

    assert.match(
      String(warn.mock.calls[0]?.arguments[0]).replaceAll(
        /\x1B\[[0-9;]*m/g,
        ''
      ),
      /There is nothing to undo/
    );
    assert.equal(select.mock.callCount(), 0);
  });

  test('takes a restored prompt back with the turns typed after it', async () => {
    writeFileSync('a.txt', 'original');
    append([
      { role: 'user', content: 'restored' },
      { role: 'assistant', content: 'earlier reply' }
    ]);

    const controller = make();

    controller.restore();
    controller.addUserMessage('typed');
    writes({ 'a.txt': 'changed' });
    await controller.takeTurn();

    picks(0);
    await controller.runCommand(Command.Undo);

    assert.equal(read('a.txt'), 'original');
    assert.deepEqual(controller.messages, []);
    assert.equal(controller.takePrefill(), 'restored');
  });

  test('never reaches into a conversation left behind by /clear', async () => {
    const controller = make();

    controller.addUserMessage('before');
    writes({ 'a.txt': 'before clear' });
    await controller.takeTurn();
    await controller.runCommand(Command.Clear);

    controller.addUserMessage('after');
    answers(reply);
    await controller.takeTurn();

    picks(0);
    await controller.runCommand(Command.Undo);

    assert.equal(read('a.txt'), 'before clear');
    assert.deepEqual(controller.messages, []);
  });
});

describe('/paste', () => {
  const pasted =
    'why does this throw?\n\nTypeError: x is undefined\n    at main';

  // what the editor hands back the next time it is opened
  const writesInEditor = (text: string) =>
    editor.mock.mockImplementationOnce(async () => text);

  test('sends what was written as a prompt and goes straight to the turn', async () => {
    const controller = make();

    writesInEditor(pasted);
    assert.equal(await controller.runCommand(Command.Paste), undefined);

    assert.deepEqual(controller.messages, [{ role: 'user', content: pasted }]);
    assert.equal(controller.needsUserInput, false);

    answers(reply);
    await controller.takeTurn();

    assert.equal(
      thinker.think.mock.calls[0].arguments[0].messages[0].content,
      pasted
    );
    assert.equal(controller.needsUserInput, true);
  });

  test('attaches files mentioned in what was written', async () => {
    const controller = make();

    writeFileSync('notes.txt', 'alpha');
    writesInEditor('look at\n@notes.txt');
    await controller.runCommand(Command.Paste);

    assert.deepEqual(controller.messages, [
      {
        role: 'user',
        content: 'look at\n@notes.txt\n\nContents of notes.txt:\n     1\talpha',
        typed: 'look at\n@notes.txt'
      }
    ]);
  });

  test('keeps it out of the history of a resumed session', async () => {
    const controller = make();

    writesInEditor(pasted);
    await controller.runCommand(Command.Paste);
    controller.addUserMessage('typed');
    answers(reply);
    await controller.takeTurn();

    const { remember, prompts } = seeded();

    make(1000, remember).restore();

    assert.deepEqual(prompts(), ['typed']);
  });

  test('sends nothing when nothing was written', async (t) => {
    const warn = t.mock.method(getLogger('run'), 'warn', () => {});
    const controller = make();

    writesInEditor('  \n\n');
    await controller.runCommand(Command.Paste);

    assert.deepEqual(controller.messages, []);
    assert.equal(controller.needsUserInput, true);
    assert.match(
      String(warn.mock.calls[0]?.arguments[0]),
      /Nothing was pasted/
    );
  });

  test('carries on when the editor cannot be opened', async (t) => {
    const error = t.mock.method(getLogger('run'), 'error', () => {});
    const controller = make();

    editor.mock.mockImplementationOnce(async () => {
      throw new Error('Failed to launch an external editor');
    });

    assert.equal(await controller.runCommand(Command.Paste), undefined);
    assert.deepEqual(controller.messages, []);
    assert.equal(controller.needsUserInput, true);
    assert.match(String(error.mock.calls[0]?.arguments[0]), /Failed to launch/);
  });

  test('can be undone, files and all, without being offered back', async () => {
    const controller = make();

    writeFileSync('a.txt', 'original');
    writesInEditor(pasted);
    await controller.runCommand(Command.Paste);
    thinker.think.mock.mockImplementationOnce(async (thought) => {
      record('a.txt');
      writeFileSync('a.txt', 'changed');

      return {
        ...thought,
        messages: [...thought.messages, reply.message as Message],
        lastResponse: reply as ThoughtState['lastResponse']
      };
    });
    await controller.takeTurn();

    select.mock.mockImplementationOnce(async () => 0 as never);
    await controller.runCommand(Command.Undo);

    const { choices } = select.mock.calls[0].arguments[0] as unknown as {
      choices: { name: string }[];
    };

    assert.match(choices[0].name, /^why does this throw\? TypeError: x is /);
    assert.doesNotMatch(choices[0].name, /\n/);
    assert.doesNotMatch(confirm.mock.calls[0].arguments[0].message, /\n/);
    assert.equal(readFileSync('a.txt').toString(), 'original');
    assert.deepEqual(controller.messages, []);
    assert.equal(controller.takePrefill(), undefined);
  });
});
