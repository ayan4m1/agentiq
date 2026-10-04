import { test, describe, before, beforeEach, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';

import {
  ApprovalMode,
  type AgentMessage,
  type ChatMessage,
  type ThoughtState
} from '../types';
import { fakePrompts } from '../../test/fakes/inquirer';
import { fakePreflight } from '../../test/fakes/preflight';
import type { ModuleMock } from '../../test/fakes/module';

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
  mock.fn<(config: { choices: readonly unknown[] }) => Promise<string>>();

// /undo asks before it throws anything away, and says yes unless told not to
const confirm = mock.fn<(config: { message: string }) => Promise<boolean>>(
  async () => true
);

// /paste opens the user's editor, which here hands back whatever the test says
const editor = mock.fn<(config: unknown) => Promise<string>>();

mock.module('@inquirer/prompts', {
  exports: fakePrompts({ select, confirm, editor }).exports
});

// /model asks the server whether the model it was given is really there, and
// downloads a tokenizer for it - neither of which belongs in a unit test
let preflightPasses = true;

const preflight = mock.fn(async () => preflightPasses);

// what the model says it can hold, for /context-limit to warn against
let contextLength: number | undefined;
const ensureTokenizer = mock.fn(async () => true);

// /model picks from a prompt of its own, and /skills toggles in another
const pickModel = mock.fn<(config: unknown) => Promise<string>>();
const pickSkills = mock.fn<(config: unknown) => Promise<void>>(async () => {});

mock.module('./picker', {
  exports: { pickModel, pickSkills } satisfies ModuleMock<
    typeof import('./picker')
  >
});

mock.module('./preflight', {
  exports: fakePreflight({
    preflight,
    modelContextLength: () => contextLength
  }).exports
});
mock.module('./tokenizer', {
  exports: {
    ensureTokenizer,
    estimateTokens: (value: string) => value.length,
    localTokenizerDir: () => undefined,
    makeTokenizer: () => (value: string) => value.length,
    usesHfTokenizer: () => true
  } satisfies ModuleMock<typeof import('./tokenizer')>
});

// check mode is tested on its own - here it only matters when the controller
// reaches for it, and with what
const check: { command?: string } = {};
const setCheck = mock.fn<(value?: string) => Promise<void>>(async () => {});
const restoreCheck = mock.fn<(command?: string) => void>();
const runCheck = mock.fn<() => Promise<void>>(async () => {});

mock.module('./check', {
  exports: { check, setCheck, restoreCheck, runCheck } satisfies ModuleMock<
    typeof import('./check')
  >
});

const { Command, createController, previewOf } = await import('./repl');
const { approval, loadRules, remember } = await import('./approval');
const { provider, session, skills, tokenizer } = await import('./config');
const { loadStore, saveStore } = await import('./models');
const { yieldToUser, takeYield } = await import('./turn');
const {
  append,
  listSessions,
  loadSession,
  sessionCheck,
  setSessionCheck,
  startSession
} = await import('./session');
const { discardCheckpoints, record } = await import('./checkpoints');
const { getLogger } = await import('./logging');
const { loadSkills, skillsDir } = await import('./skills');

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
    mcp: 6,
    messages: 0,
    total: 35,
    measured: false
  },
  turnCount: 0,
  load: mock.fn((messages: ChatMessage[]) => messages.length),
  reset: mock.fn(() => 0),
  rebuild: mock.fn((messages: ChatMessage[]) => messages.length),
  count: mock.fn(async (messages: ChatMessage[]) => {
    void messages;
  }),
  compact: mock.fn(async (messages: ChatMessage[]) => ({ messages, freed: 0 })),
  recap: mock.fn<
    (messages: ChatMessage[], turns?: number) => Promise<string | undefined>
  >(async () => undefined),
  think: mock.fn(
    async (thought: ThoughtState): Promise<ThoughtState> => thought
  )
});

let thinker: ReturnType<typeof makeThinker>;

const make = (
  compactAt = 1000,
  rememberPrompts?: (prompts: string[]) => void,
  rememberPrompt?: (line: string) => void
) =>
  // the fake covers what the controller uses, not every field of a thinker
  createController({
    thinker: thinker as never,
    compactAt: () => compactAt,
    rememberPrompts,
    rememberPrompt
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
    messages: [...thought.messages, response.message as ChatMessage],
    lastResponse: response as ThoughtState['lastResponse']
  }));

// the model's answers to the next few turns, in order - answers() only ever
// covers the very next call
const answersInOrder = (...responses: { message: object }[]) => {
  for (const [index, response] of responses.entries()) {
    thinker.think.mock.mockImplementationOnce(
      async (thought) => ({
        ...thought,
        messages: [...thought.messages, response.message as ChatMessage],
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
  provider.contextLimit = 4096;
  preflight.mock.resetCalls();
  ensureTokenizer.mock.resetCalls();
  log.mock.resetCalls();
  select.mock.resetCalls();
  pickModel.mock.resetCalls();
  pickSkills.mock.resetCalls();
  confirm.mock.resetCalls();
  editor.mock.resetCalls();
  discardCheckpoints();
  takeYield();
  check.command = undefined;
  setCheck.mock.resetCalls();
  restoreCheck.mock.resetCalls();
  runCheck.mock.resetCalls();
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

  test('seeds the history of a resumed session with the typed prompt', async () => {
    append([
      {
        role: 'user',
        content: 'read @notes.txt\n\nContents of notes.txt:\n     1\talpha',
        typed: 'read @notes.txt'
      } as ChatMessage
    ]);

    const { remember, prompts } = seeded();

    await make(1000, remember).restore();

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

  test('reports a failed model call', async () => {
    const controller = make();

    thinker.think.mock.mockImplementationOnce(async () => {
      throw new Error('connection refused');
    });

    assert.equal(await controller.runPrompt('hello'), false);
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
    const summary: ChatMessage = { role: 'user', content: 'summary' };

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

describe('/check', () => {
  test('hands its argument to check mode', async () => {
    await make().runCommand('check on');

    assert.deepEqual(setCheck.mock.calls[0].arguments, ['on']);
  });

  test('hands over a command of its own exactly as it was typed', async () => {
    const controller = make();

    await controller.runCommand('check  npm run  lint -- --quiet');
    await controller.runCommand('check');

    assert.deepEqual(setCheck.mock.calls[0].arguments, [
      'npm run  lint -- --quiet'
    ]);
    assert.deepEqual(setCheck.mock.calls[1].arguments, [undefined]);
  });

  test('runs once the model hands back to the user', async () => {
    const controller = make();

    controller.addUserMessage('hello');
    record('a.txt');
    answers(reply);
    await controller.takeTurn();

    assert.equal(runCheck.mock.callCount(), 1);
  });

  test('does not run when the turn changed no files', async () => {
    const controller = make();

    controller.addUserMessage('hello');
    answers(reply);
    await controller.takeTurn();

    assert.equal(runCheck.mock.callCount(), 0);
  });

  test('does not check the same changes twice', async () => {
    const controller = make();

    check.command = 'yarn lint';
    controller.addUserMessage('hello');
    record('a.txt');
    answers(reply);
    await controller.takeTurn();
    controller.addUserMessage('thanks');
    answers(reply);
    await controller.takeTurn();

    assert.equal(runCheck.mock.callCount(), 1);
  });

  test('checks changes left by an interrupted turn on the next one', async () => {
    const controller = make();

    check.command = 'yarn lint';
    controller.addUserMessage('hello');
    record('a.txt');
    thinker.think.mock.mockImplementationOnce(async (thought) => ({
      ...thought,
      interrupted: true
    }));
    await controller.takeTurn();
    assert.equal(runCheck.mock.callCount(), 0);

    controller.addUserMessage('go on');
    answers(reply);
    await controller.takeTurn();

    assert.equal(runCheck.mock.callCount(), 1);
  });

  test('waits while the model is still calling tools', async () => {
    const controller = make();

    controller.addUserMessage('hello');
    answers(toolCall);
    await controller.takeTurn();

    assert.equal(runCheck.mock.callCount(), 0);
  });

  test('does not run after a failed model call', async () => {
    const controller = make();

    controller.addUserMessage('hello');
    thinker.think.mock.mockImplementationOnce(async () => {
      throw new Error('connection refused');
    });
    await controller.takeTurn();

    assert.equal(runCheck.mock.callCount(), 0);
  });

  test('comes back with a resumed session', async () => {
    append([{ role: 'user', content: 'earlier' }]);
    setSessionCheck('yarn test');
    startSession();

    await make().restore();

    assert.deepEqual(restoreCheck.mock.calls[0].arguments, ['yarn test']);
  });

  test('asks the provider to count the emptied conversation', async () => {
    await make().clear();

    assert.equal(thinker.count.mock.callCount(), 1);
    assert.deepEqual(thinker.count.mock.calls[0].arguments[0], []);
  });

  test('carries over into the session /clear starts', async () => {
    check.command = 'yarn lint';

    await make().clear();

    assert.equal(sessionCheck(), 'yarn lint');
  });
});

describe('restore', () => {
  // and offers no prompt history back, since there is none to offer
  test('fails when there is nothing to resume', async () => {
    const { remember } = seeded();

    assert.equal(await make(1000, remember).restore(), false);
    assert.equal(remember.mock.callCount(), 0);
  });

  test('fails for a session that does not exist', async () => {
    const { remember } = seeded();

    assert.equal(await make(1000, remember).restore('no-such-session'), false);
    assert.equal(remember.mock.callCount(), 0);
  });

  test('picks up the most recent session', async () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'earlier' },
      { role: 'assistant', content: 'reply' }
    ];

    append(messages);

    const controller = make();

    assert.equal(await controller.restore(), true);
    assert.deepEqual(controller.messages, messages);
    assert.deepEqual(thinker.load.mock.calls[0].arguments[0], messages);
    assert.equal(controller.needsUserInput, true);
  });

  test('asks the provider to count what it resumed', async () => {
    const messages: ChatMessage[] = [{ role: 'user', content: 'earlier' }];

    append(messages);

    assert.equal(await make().restore(), true);
    assert.deepEqual(thinker.count.mock.calls[0].arguments[0], messages);
  });

  test('picks up a session by id', async () => {
    const id = startSession();

    append([{ role: 'user', content: 'by id' }]);
    startSession();

    const controller = make();

    assert.equal(await controller.restore(id), true);
    assert.equal(controller.messages[0].content, 'by id');
  });

  test('offers back what the user typed, oldest first', async () => {
    append([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply' },
      { role: 'tool', tool_name: 'read', content: 'file contents' },
      { role: 'user', content: 'second' }
    ]);

    const { remember, prompts } = seeded();

    assert.equal(await make(1000, remember).restore(), true);
    assert.deepEqual(prompts(), ['first', 'second']);
  });

  test('leaves out the notes compaction wrote', async () => {
    append([
      { role: 'user', content: 'typed' },
      // deliberately one line, so only the flag could leave it out
      { role: 'user', content: 'what happened earlier', summary: true }
    ]);

    const { remember, prompts } = seeded();

    assert.equal(await make(1000, remember).restore(), true);
    assert.deepEqual(prompts(), ['typed']);
  });

  test('leaves out blank prompts and previews multi-line ones', async () => {
    append([
      { role: 'user', content: '   ' },
      { role: 'user', content: 'pasted\nover two lines' },
      { role: 'user', content: 'typed' }
    ]);

    const { remember, prompts } = seeded();

    assert.equal(await make(1000, remember).restore(), true);
    assert.deepEqual(prompts(), ['pasted … (+1 line)', 'typed']);
  });

  test('offers back only the most recent prompts', async () => {
    append(
      ['oldest', 'older', 'newer', 'newest'].map((content) => ({
        role: 'user',
        content
      }))
    );

    const { remember, prompts } = seeded();

    assert.equal(await make(1000, remember).restore(), true);
    // AQ_HISTORY_LIMIT is 3 for this run
    assert.deepEqual(prompts(), ['older', 'newer', 'newest']);
  });

  test('does not recap on its own', async () => {
    append([
      { role: 'user', content: 'earlier' },
      { role: 'assistant', content: 'the last reply' }
    ]);

    assert.equal(await make().restore(), true);
    assert.equal(thinker.recap.mock.callCount(), 0);
  });
});

const gemma = { model: 'gemma4:e4b', tokenizer: 'google/gemma-4-E4B' };
const qwen = { model: 'qwen3:30b', tokenizer: 'Qwen/Qwen3-Coder-30B' };

// a session already running on one of two saved models, which is what /model
// is for - the store and the config have to agree before it is asked to switch
const onModel = (entry: typeof gemma) => {
  saveStore({
    active: { ollama: entry.model },
    models: { ollama: [gemma, qwen] }
  });
  provider.model = entry.model;
  tokenizer.repo = entry.tokenizer;

  return make();
};

describe('/recap', () => {
  const conversation = (): ChatMessage[] => [
    { role: 'user', content: 'earlier' },
    { role: 'assistant', content: 'the last reply' }
  ];

  test('recaps the conversation over the configured turns', async () => {
    const messages = conversation();

    append(messages);

    const { remember, prompts } = seeded();
    const controller = make(1000, remember);

    await controller.restore();
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
    // the MCP tools are taken out of the built-in line rather than counted twice
    assert.match(printed(), /\{TOOLS {4}\} - 14 tokens/);
    assert.match(printed(), /\{MCP {6}\} - 6 tokens/);
    assert.match(printed(), /\{MESSAGES \} - 0 tokens/);
    assert.match(printed(), /\{TOTAL {4}\} - 35 tokens/);
  });

  test('shows the context limit for /context-limit', async () => {
    contextLength = 8192;
    provider.model = gemma.model;
    await make().runCommand(Command.ContextLimit);

    assert.match(printed(), /Context limit is 4096 tokens/);
    assert.match(printed(), /gemma4:e4b supports 8192/);
  });

  test('changes the context limit for /context-limit <value>', async () => {
    await make().runCommand(`${Command.ContextLimit} 8192`);

    assert.equal(provider.contextLimit, 8192);
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

    assert.equal(provider.contextLimit, 4096);
  });

  test('allows a context limit past what the model supports', async () => {
    contextLength = 2048;
    await make().runCommand(`${Command.ContextLimit} 16384`);

    assert.equal(provider.contextLimit, 16384);
  });

  test('compacts at once when the limit drops below the context', async () => {
    const controller = createController({
      thinker: thinker as never,
      compactAt: () => provider.contextLimit / 2
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
      select.mock.calls[0].arguments[0].choices.map(
        (choice) => (choice as { value: string }).value
      ),
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

    assert.equal(provider.model, qwen.model);
    assert.equal(tokenizer.repo, qwen.tokenizer);
    // the next run starts where this session ended up
    assert.equal(loadStore().active.ollama, qwen.model);
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

    assert.equal(provider.model, gemma.model);
    assert.equal(tokenizer.repo, gemma.tokenizer);
    // a switch that did not happen must not decide what the next run starts on
    assert.equal(loadStore().active.ollama, gemma.model);
    assert.equal(thinker.rebuild.mock.callCount(), 0);
    assert.equal(ensureTokenizer.mock.callCount(), 0);
  });

  test('stays where it was when the new model cannot hold the session', async (t) => {
    const error = t.mock.method(getLogger('run'), 'error', () => {});
    const controller = onModel(gemma);

    // the fake thinker already counts 35 tokens
    contextLength = 20;
    controller.addUserMessage('hello');
    pickModel.mock.mockImplementationOnce(async () => qwen.model);
    await controller.runCommand(Command.Model);

    assert.equal(provider.model, gemma.model);
    assert.equal(tokenizer.repo, gemma.tokenizer);
    assert.equal(loadStore().active.ollama, gemma.model);
    assert.match(
      String(error.mock.calls[0]?.arguments[0]),
      /supports 20 tokens, but this session already needs 35/
    );
    // the old model is asked about again and the session counted by its tokenizer
    assert.equal(preflight.mock.callCount(), 2);
    assert.equal(thinker.rebuild.mock.callCount(), 2);
    assert.deepEqual(thinker.rebuild.mock.calls[1].arguments[0], [
      { role: 'user', content: 'hello' }
    ]);
  });

  test('switches when the new model has room for the session', async () => {
    const controller = onModel(gemma);

    contextLength = 8192;
    pickModel.mock.mockImplementationOnce(async () => qwen.model);
    await controller.runCommand(Command.Model);

    assert.equal(provider.model, qwen.model);
    assert.equal(thinker.rebuild.mock.callCount(), 1);
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

    assert.equal(provider.model, gemma.model);
    assert.equal(thinker.rebuild.mock.callCount(), 0);
  });

  test('reports on the files written for /changes', async () => {
    await make().runCommand(Command.Changes);

    assert.match(printed(), /Nothing has been written this session/);
  });
});

describe('saved commands', () => {
  // each test works in a project of its own, so the commands go with it
  const save = (file: string, content: string) => {
    mkdirSync(resolve('.agentiq', 'commands'), { recursive: true });
    writeFileSync(resolve('.agentiq', 'commands', file), content);
  };

  test('sends a saved command as its prompt, and keeps what was typed', async () => {
    const controller = make();

    save('review.md', '---\ndescription: Review\n---\nReview $1 for bugs\n');

    assert.equal(await controller.runCommand('review src/a.ts'), undefined);
    assert.deepEqual(controller.messages, [
      {
        role: 'user',
        content: 'Review src/a.ts for bugs',
        typed: '/review src/a.ts'
      }
    ]);
    assert.equal(controller.needsUserInput, false);
  });

  test('attaches files mentioned in a saved command', async () => {
    const controller = make();

    writeFileSync('notes.txt', 'alpha');
    save('notes.md', 'Summarise @notes.txt');
    await controller.runCommand('notes');

    const [message] = controller.messages;

    assert.match(
      message.content,
      /^Summarise @notes\.txt\n\nContents of notes\.txt:/
    );
    assert.equal((message as AgentMessage).typed, '/notes');
  });

  test('runs the built-in when a saved command shares its name', async () => {
    const controller = make();

    save('mode.md', 'not a mode');
    await controller.runCommand(Command.Mode);

    assert.equal(approval.mode, ApprovalMode.Auto);
    assert.deepEqual(controller.messages, []);
  });

  test('lists saved commands with their descriptions for /help', async () => {
    save('review.md', '---\ndescription: Review the diff\n---\nReview');
    save('commit.md', 'Commit');
    await make().runCommand(Command.Help);

    assert.match(printed(), /\/review - Review the diff/);
    assert.match(printed(), /\/commit$/m);
  });

  test('sends a saved command given to runPrompt', async () => {
    const controller = make();

    save('review.md', 'Review $ARGUMENTS');
    answers(reply);

    assert.equal(await controller.runPrompt('/review the diff'), true);
    assert.equal(
      thinker.think.mock.calls[0].arguments[0].messages[0].content,
      'Review the diff'
    );
  });

  test('sends any other prompt starting with a slash as it was given', async () => {
    const controller = make();

    answers(reply);
    await controller.runPrompt('/usr/bin is missing');

    assert.equal(
      thinker.think.mock.calls[0].arguments[0].messages[0].content,
      '/usr/bin is missing'
    );
  });

  test('offers the /command back after /undo', async () => {
    const controller = make();

    save('review.md', 'Review $ARGUMENTS');
    await controller.runCommand('review a.ts');
    answers(reply);
    await controller.takeTurn();
    select.mock.mockImplementationOnce(async () => 0 as never);
    await controller.runCommand(Command.Undo);

    assert.equal(controller.takePrefill(), '/review a.ts');
  });
});

describe('/rules', () => {
  type RulesRequest = {
    choices: { name: string; value: string; label?: string }[];
    browse?: boolean;
    remove: (value: string) => void;
  };

  const request = () => pickModel.mock.calls[0].arguments[0] as RulesRequest;

  test('says so instead of opening an empty list', async (t) => {
    const info = t.mock.method(getLogger('run'), 'info', () => {});

    await make().runCommand(Command.Rules);

    assert.equal(pickModel.mock.callCount(), 0);
    assert.match(
      String(info.mock.calls[0]?.arguments[0]),
      /No approval rules are saved for this project/
    );
  });

  test('says so once the last rule has been forgotten', async (t) => {
    const info = t.mock.method(getLogger('run'), 'info', () => {});
    const controller = make();

    remember('command', 'yarn test');
    pickModel.mock.mockImplementationOnce(async (config) => {
      (config as RulesRequest).remove('command:yarn test');

      return undefined as never;
    });
    await controller.runCommand(Command.Rules);
    await controller.runCommand(Command.Rules);

    assert.equal(pickModel.mock.callCount(), 1);
    assert.match(
      String(info.mock.calls.at(-1)?.arguments[0]),
      /No approval rules are saved for this project/
    );
  });

  test('lists commands then paths to browse', async () => {
    remember('path', 'src/index.ts');
    remember('command', 'yarn lint');
    pickModel.mock.mockImplementationOnce(async () => undefined as never);

    await make().runCommand(Command.Rules);

    const { browse, choices } = request();

    assert.equal(browse, true);
    assert.deepEqual(
      choices.map(({ value }) => value),
      ['command:yarn lint', 'path:src/index.ts']
    );
    assert.equal(choices[0].label, 'the command rule yarn lint');
  });

  test('forgets the rule removed from the list', async () => {
    remember('command', 'yarn lint');
    remember('command', 'git push');
    pickModel.mock.mockImplementationOnce(async (config) => {
      (config as RulesRequest).remove('command:git push');

      return undefined as never;
    });

    await make().runCommand(Command.Rules);

    assert.deepEqual(loadRules().command, ['yarn lint']);
  });

  test('adds a rule exactly as it was typed', async () => {
    await make().runCommand('rules add command yarn  test *');
    await make().runCommand('rules add path src/**');
    await make().runCommand('rules add tool mcp__github__*');

    assert.deepEqual(loadRules(), {
      command: ['yarn  test *'],
      path: ['src/**'],
      tool: ['mcp__github__*']
    });
  });

  test('explains itself for anything it does not understand', async (t) => {
    const error = t.mock.method(getLogger('run'), 'error', () => {});

    await make().runCommand('rules add bogus x');
    await make().runCommand('rules add command');
    await make().runCommand('rules forget 1');

    assert.equal(error.mock.callCount(), 3);
    assert.match(
      String(error.mock.calls[0].arguments[0]),
      /\/rules add command\|path\|tool <pattern>/
    );
    assert.deepEqual(loadRules(), { command: [], path: [], tool: [] });
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
        messages: [...thought.messages, reply.message as ChatMessage],
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

    await controller.restore();
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

  const preview = 'why does this throw? … (+3 lines)';

  // what the editor hands back the next time it is opened
  const writesInEditor = (text: string) =>
    editor.mock.mockImplementationOnce(async () => text);

  // what the editor started out holding the last time it was opened
  const editorDefault = () =>
    (editor.mock.calls.at(-1)?.arguments[0] as { default?: string }).default;

  // the lines handed to the prompt history, in order
  const remembered = () => {
    const remember = mock.fn<(line: string) => void>();

    return {
      remember,
      lines: () => remember.mock.calls.map((call) => call.arguments[0])
    };
  };

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

  test('hands the prompt history a preview of it', async () => {
    const { remember, lines } = remembered();
    const controller = make(1000, undefined, remember);

    writesInEditor(pasted);
    await controller.runCommand(Command.Paste);

    assert.deepEqual(lines(), [preview]);
  });

  test('hands the prompt history a single line as it is', async () => {
    const { remember, lines } = remembered();
    const controller = make(1000, undefined, remember);

    writesInEditor('just the one line\n');
    await controller.runCommand(Command.Paste);

    assert.deepEqual(lines(), ['just the one line']);
  });

  test('opens the whole of a recalled preview in the editor again', async () => {
    const controller = make();

    writesInEditor(pasted);
    await controller.runCommand(Command.Paste);
    assert.equal(editorDefault(), undefined);

    writesInEditor(`${pasted}\nand again`);
    assert.equal(await controller.reopenPaste(preview), true);

    assert.equal(editorDefault(), pasted);
    assert.equal(controller.messages[1].content, `${pasted}\nand again`);
    assert.equal(controller.needsUserInput, false);
  });

  test('leaves anything but a preview alone', async () => {
    const controller = make();

    writesInEditor(pasted);
    await controller.runCommand(Command.Paste);

    const opened = editor.mock.callCount();

    assert.equal(await controller.reopenPaste('why does this throw?'), false);
    assert.equal(editor.mock.callCount(), opened);
  });

  test('offers it back to a resumed session as its preview', async () => {
    const controller = make();

    writesInEditor(pasted);
    await controller.runCommand(Command.Paste);
    controller.addUserMessage('typed');
    answers(reply);
    await controller.takeTurn();

    const { remember, prompts } = seeded();
    const resumed = make(1000, remember);

    await resumed.restore();

    assert.deepEqual(prompts(), [preview, 'typed']);

    writesInEditor(pasted);
    assert.equal(await resumed.reopenPaste(preview), true);
    assert.equal(editorDefault(), pasted);
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

  test('can be undone, files and all, and offered back as its preview', async () => {
    const controller = make();

    writeFileSync('a.txt', 'original');
    writesInEditor(pasted);
    await controller.runCommand(Command.Paste);
    thinker.think.mock.mockImplementationOnce(async (thought) => {
      record('a.txt');
      writeFileSync('a.txt', 'changed');

      return {
        ...thought,
        messages: [...thought.messages, reply.message as ChatMessage],
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
    assert.equal(controller.takePrefill(), preview);

    writesInEditor(pasted);
    assert.equal(await controller.reopenPaste(preview), true);
    assert.equal(editorDefault(), pasted);
  });
});

describe('previewOf', () => {
  test('gives the first line and how many follow it', () => {
    assert.equal(previewOf('one\ntwo\nthree'), 'one … (+2 lines)');
    assert.equal(previewOf('one\r\ntwo'), 'one … (+1 line)');
  });

  test('skips blank lines around the text', () => {
    assert.equal(
      previewOf('\n\n  first   line \nsecond\n\n'),
      'first line … (+1 line)'
    );
  });

  test('cuts a long first line short', () => {
    assert.equal(
      previewOf(`${'x'.repeat(80)}\nmore`),
      `${'x'.repeat(60)}… … (+1 line)`
    );
  });
});

describe('/skills', () => {
  type SkillsRequest = {
    choices: { name: string; description: string; enabled: boolean }[];
    toggle: (name: string, enabled: boolean) => void;
  };

  const request = () => pickSkills.mock.calls[0].arguments[0] as SkillsRequest;

  const addSkill = (name: string) => {
    mkdirSync(resolve(skillsDir, name), { recursive: true });
    writeFileSync(
      resolve(skillsDir, name, 'SKILL.md'),
      `---\nname: ${name}\ndescription: About ${name}\n---\n`
    );
  };

  beforeEach(() => {
    rmSync(skillsDir, { recursive: true, force: true });
    skills.disabled = [];
    loadSkills();
  });

  test('says so instead of opening an empty list', async (t) => {
    const info = t.mock.method(getLogger('run'), 'info', () => {});

    await make().runCommand(Command.Skills);

    assert.equal(pickSkills.mock.callCount(), 0);
    assert.match(
      String(info.mock.calls[0]?.arguments[0]),
      /No skills are installed/
    );
  });

  test('lists every skill installed with whether it is enabled', async () => {
    addSkill('alpha');
    addSkill('beta');
    loadSkills();
    skills.disabled = ['beta'];

    await make().runCommand(Command.Skills);

    assert.deepEqual(request().choices, [
      { name: 'alpha', description: 'About alpha', enabled: true },
      { name: 'beta', description: 'About beta', enabled: false }
    ]);
  });

  test('saves a toggle and rebuilds the prompt around it', async () => {
    addSkill('alpha');
    loadSkills();
    pickSkills.mock.mockImplementationOnce(async (config) => {
      (config as SkillsRequest).toggle('alpha', false);
    });

    await make().runCommand(Command.Skills);

    assert.deepEqual(skills.disabled, ['alpha']);
    assert.match(
      readFileSync(resolve(process.env.AQ_HOME!, 'config.yml'), 'utf8'),
      /disabled:\s*\n\s*- alpha/
    );
    assert.equal(thinker.rebuild.mock.callCount(), 1);
    assert.equal(thinker.count.mock.callCount(), 1);
  });

  test('leaves the prompt alone when nothing was toggled', async () => {
    addSkill('alpha');
    loadSkills();

    await make().runCommand(Command.Skills);

    assert.equal(thinker.rebuild.mock.callCount(), 0);
  });

  test('keeps a toggle made before the picker failed', async (t) => {
    t.mock.method(getLogger('run'), 'error', () => {});
    addSkill('alpha');
    loadSkills();
    pickSkills.mock.mockImplementationOnce(async (config) => {
      (config as SkillsRequest).toggle('alpha', false);

      throw new Error('User force closed the prompt');
    });

    await make().runCommand(Command.Skills);

    assert.deepEqual(skills.disabled, ['alpha']);
    assert.equal(thinker.rebuild.mock.callCount(), 1);
  });
});
