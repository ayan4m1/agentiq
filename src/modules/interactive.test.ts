import { test, describe, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

// the repl is the prompt and a loop around it, so everything it talks to is
// replaced by a fake, and the user at the prompt is played from a script. the
// loop only ends through process.exit, which throws for the length of a test
let agentStarts: boolean;
let restored: boolean;
// what the user types, in order - a script that runs dry fails the test rather
// than leaving the loop waiting forever
let answers: string[];
// what needsUserInput says, in order, before it settles on true
let needsInput: boolean[];
// the prompts a restored session hands back to the history
let rememberedPrompts: string[] | undefined;
// how many times the prompt had been shown when each turn was taken
let promptsBeforeTurns: number[];

type PromptOptions = {
  type: string;
  name: string;
  message: string;
  context: string;
  prefill?: string;
};

type ControllerOptions = {
  compactAt: () => number;
  rememberPrompts: (prompts: string[]) => void;
};

let controllerOptions: ControllerOptions | undefined;

const prompt = mock.fn<
  (options: PromptOptions) => Promise<{ userMessage?: string }>
>(async () => {
  if (!answers.length) {
    throw new Error('the prompt was shown more often than the test expected');
  }

  return { userMessage: answers.shift() };
});

// the prompt ModeCommandPrompt extends, so its super calls land somewhere a
// test can see
const superKeypress = mock.fn<(event?: unknown) => Promise<void>>(
  async () => {}
);
const superRender = mock.fn();
const superRun = mock.fn(async () => 'answer');
const addToHistory = mock.fn<(context: string, value: string) => void>();

class CommandPromptBase {
  static addToHistory = addToHistory;

  rl = {
    line: '',
    cursor: 0,
    output: { unmute: mock.fn() },
    write: mock.fn<(data: string | null) => void>()
  };
  opt: { message: string; prefill?: string } = { message: '' };

  run() {
    return superRun();
  }
  screen = {
    clean: mock.fn<(lines: number) => void>(),
    height: 3,
    extraLinesUnderPrompt: 2
  };

  onKeypress(event?: unknown) {
    return superKeypress(event);
  }

  render() {
    return superRender();
  }
}

type ModePrompt = CommandPromptBase & {
  onKeypress(event?: unknown): Promise<unknown>;
  run(): Promise<unknown>;
};

const registerPrompt =
  mock.fn<(name: string, prompt: new () => ModePrompt) => void>();

const schedule = mock.fn();
const cleanUp = mock.fn();
const startAgent = mock.fn(async () =>
  agentStarts
    ? { thinker: { tokens: { messages: 42 } }, schedule, cleanUp }
    : undefined
);

const controller = {
  get needsUserInput() {
    return needsInput.length ? needsInput.shift() : true;
  },
  restore: mock.fn<(id?: string) => boolean>(() => {
    if (rememberedPrompts) {
      controllerOptions?.rememberPrompts(rememberedPrompts);
    }

    return restored;
  }),
  runCommand: mock.fn(async (name: string) => name),
  // what /undo left for the next prompt, handed out once like the real thing
  takePrefill: mock.fn<() => string | undefined>(() => undefined),
  addUserMessage: mock.fn<(message: string) => void>(),
  takeTurn: mock.fn<(schedule: unknown) => Promise<void>>(async () => {
    promptsBeforeTurns.push(prompt.mock.callCount());
  })
};
const createController = mock.fn((options: ControllerOptions) => {
  controllerOptions = options;
  return controller;
});

const pruneSessions = mock.fn();
const startSession = mock.fn();
const cycleMode = mock.fn();
const describeMode = mock.fn(() => 'manual');

mock.module('inquirer', { defaultExport: { prompt, registerPrompt } });
mock.module('inquirer-command-prompt', { defaultExport: CommandPromptBase });
mock.module('./startup', { namedExports: { startAgent } });
mock.module('./repl', {
  namedExports: {
    Command: { Help: 'help', Quit: 'quit' },
    createController,
    systemColor: (text: string) => text
  }
});
mock.module('./session', { namedExports: { pruneSessions, startSession } });
mock.module('./approval', { namedExports: { cycleMode, describeMode } });
mock.module('./config', { namedExports: { ollama: { contextLimit: 1000 } } });
mock.module('./ollama', { namedExports: { compactThreshold: 0.5 } });

const { startRepl } = await import('./interactive');

class ExitError extends Error {
  readonly code: number | undefined;

  constructor(code: number | undefined) {
    super(`exited with ${code}`);
    this.code = code;
  }
}

// runs the repl until it exits, and says with what
const exitCodeOf = async (resume?: string | boolean) => {
  let code: number | undefined;

  await assert.rejects(startRepl({ resume }), (error) => {
    assert.ok(error instanceof ExitError, error as Error);
    code = error.code;

    return true;
  });

  return code;
};

const argumentsOf = (fn: { mock: { calls: { arguments: unknown[] }[] } }) =>
  fn.mock.calls.map((call) => call.arguments);

describe('startRepl', () => {
  // restoring every mock would take the module mocks with it
  let exit: { mock: { restore(): void } };

  beforeEach(() => {
    agentStarts = true;
    restored = true;
    answers = ['/quit'];
    needsInput = [];
    rememberedPrompts = undefined;
    promptsBeforeTurns = [];
    controllerOptions = undefined;

    for (const fn of [
      prompt,
      superKeypress,
      superRender,
      superRun,
      addToHistory,
      registerPrompt,
      schedule,
      cleanUp,
      startAgent,
      controller.restore,
      controller.runCommand,
      controller.takePrefill,
      controller.addUserMessage,
      controller.takeTurn,
      createController,
      pruneSessions,
      startSession,
      cycleMode,
      describeMode
    ]) {
      fn.mock.resetCalls();
    }

    exit = mock.method(process, 'exit', (code?: number) => {
      throw new ExitError(code);
    });
  });

  afterEach(() => {
    exit.mock.restore();
  });

  test('exits with a failure when the agent cannot start', async () => {
    agentStarts = false;

    assert.equal(await exitCodeOf(), 1);
    assert.equal(createController.mock.callCount(), 0);
    assert.equal(pruneSessions.mock.callCount(), 0);
    assert.equal(prompt.mock.callCount(), 0);
  });

  test('prunes old sessions and starts a new one', async () => {
    assert.equal(await exitCodeOf(), 0);

    assert.equal(pruneSessions.mock.callCount(), 1);
    assert.equal(controller.restore.mock.callCount(), 0);
    assert.equal(startSession.mock.callCount(), 1);
  });

  test('compacts at the threshold of the context limit', async () => {
    await exitCodeOf();

    assert.equal(controllerOptions?.compactAt(), 500);
  });

  test('resumes a session by id', async () => {
    assert.equal(await exitCodeOf('abc'), 0);

    assert.deepEqual(argumentsOf(controller.restore), [['abc']]);
    assert.equal(startSession.mock.callCount(), 0);
  });

  test('resumes the most recent session when given no id', async () => {
    await exitCodeOf(true);

    assert.deepEqual(argumentsOf(controller.restore), [[undefined]]);
    assert.equal(startSession.mock.callCount(), 0);
  });

  test('starts a new session when there is none to resume', async () => {
    restored = false;

    await exitCodeOf(true);

    assert.equal(controller.restore.mock.callCount(), 1);
    assert.equal(startSession.mock.callCount(), 1);
  });

  test('prompts with the mode, token count and history context', async () => {
    await exitCodeOf();

    const [options] = prompt.mock.calls[0].arguments;

    assert.equal(options.type, 'command');
    assert.equal(options.name, 'userMessage');
    assert.equal(options.context, 'history-0');
    assert.match(options.message, /^manual\[42 tok\]\n.*>/);
  });

  test('files resumed prompts under a new history context', async () => {
    rememberedPrompts = ['first', 'second'];

    await exitCodeOf('abc');

    assert.deepEqual(argumentsOf(addToHistory), [
      ['history-1', 'first'],
      ['history-1', 'second']
    ]);
    assert.equal(prompt.mock.calls[0].arguments[0].context, 'history-1');
  });

  test('starts each repl on a history of its own', async () => {
    rememberedPrompts = ['first'];
    await exitCodeOf('abc');

    answers = ['/quit'];
    prompt.mock.resetCalls();
    await exitCodeOf('abc');

    assert.equal(prompt.mock.calls[0].arguments[0].context, 'history-1');
  });

  test('sends a message and takes a turn on it', async () => {
    answers = ['hello', '/quit'];

    await exitCodeOf();

    assert.deepEqual(argumentsOf(controller.addUserMessage), [['hello']]);
    assert.deepEqual(argumentsOf(controller.takeTurn), [[schedule]]);
  });

  test('runs a command without taking a turn on it', async () => {
    answers = ['/help', '/quit'];

    await exitCodeOf();

    assert.deepEqual(argumentsOf(controller.runCommand), [['help'], ['quit']]);
    assert.equal(controller.addUserMessage.mock.callCount(), 0);
    assert.equal(controller.takeTurn.mock.callCount(), 0);
    assert.equal(prompt.mock.callCount(), 2);
  });

  test('starts the prompt with whatever /undo handed back', async () => {
    answers = ['/undo', '/quit'];
    controller.takePrefill.mock.mockImplementationOnce(() => 'try again', 1);

    await exitCodeOf();

    assert.equal(prompt.mock.calls[0].arguments[0].prefill, undefined);
    assert.equal(prompt.mock.calls[1].arguments[0].prefill, 'try again');
  });

  test('takes a turn before prompting when no input is needed', async () => {
    needsInput = [false];

    await exitCodeOf();

    assert.deepEqual(promptsBeforeTurns, [0]);
  });

  test('cleans up and exits on quit', async () => {
    assert.equal(await exitCodeOf(), 0);

    assert.equal(cleanUp.mock.callCount(), 1);
  });

  describe('mode prompt', () => {
    let instance: ModePrompt;

    beforeEach(async () => {
      await exitCodeOf();

      const [name, ModeCommandPrompt] = registerPrompt.mock.calls[0].arguments;

      assert.equal(name, 'command');

      instance = new ModeCommandPrompt();
      instance.rl.line = 'ab\t';
      instance.rl.cursor = 3;
    });

    test('passes every other key through', async () => {
      for (const event of [
        undefined,
        { key: { name: 'a' } },
        { key: { name: 'tab', shift: false } }
      ]) {
        await instance.onKeypress(event);
      }

      assert.equal(superKeypress.mock.callCount(), 3);
      assert.equal(cycleMode.mock.callCount(), 0);
      assert.equal(instance.rl.line, 'ab\t');
    });

    test('cycles the mode on shift+tab and redraws', async () => {
      describeMode.mock.mockImplementationOnce(() => 'auto');

      await instance.onKeypress({ key: { name: 'tab', shift: true } });

      assert.equal(superKeypress.mock.callCount(), 0);
      assert.equal(instance.rl.output.unmute.mock.callCount(), 1);
      assert.deepEqual(argumentsOf(instance.screen.clean), [[2]]);
      assert.equal(instance.screen.height, 0);
      assert.equal(instance.screen.extraLinesUnderPrompt, 0);
      assert.equal(cycleMode.mock.callCount(), 1);
      assert.equal(instance.rl.line, 'ab');
      assert.equal(instance.rl.cursor, 2);
      assert.match(instance.opt.message, /^auto\[42 tok\]/);
      assert.equal(superRender.mock.callCount(), 1);
    });

    test('writes a prefill into the line once it is running', async () => {
      instance.opt.prefill = 'try again';

      assert.equal(await instance.run(), 'answer');
      assert.deepEqual(argumentsOf(instance.rl.write), [['try again']]);
      assert.equal(superRender.mock.callCount(), 1);
    });

    test('leaves the line alone without a prefill', async () => {
      await instance.run();

      assert.equal(superRun.mock.callCount(), 1);
      assert.equal(instance.rl.write.mock.callCount(), 0);
      assert.equal(superRender.mock.callCount(), 0);
    });
  });
});
