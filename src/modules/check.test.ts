import { test, describe, before, beforeEach, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import type { ChatRequest } from 'ollama';

// config reads the home directory as it is evaluated, so it has to point
// somewhere disposable before anything imports it
const root = mkdtempSync(resolve(tmpdir(), 'agentiq-check-'));
const original = process.cwd();

process.env.AQ_HOME = resolve(root, 'home');

// escape is watched for on a real terminal, which a test does not have - so
// the watcher hands its callback over instead, for a test to press escape with
let pressEscape: (() => void) | undefined;
const stopWatching = mock.fn();
const watchForInterrupt = mock.fn((onInterrupt: () => void) => {
  pressEscape = onInterrupt;

  return stopWatching;
});

mock.module('./interrupt', { exports: { watchForInterrupt } });

// the spinner draws on a real terminal, so a fake stands in for it
const ora = mock.fn(() => ({
  start: () => {},
  stop: () => {},
  isSpinning: false
}));

mock.module('ora', { exports: { default: ora } });

// the approval mode is whatever the test says it is
let planning = false;
const refusePlanning = mock.fn(() => (planning ? 'refused' : undefined));

mock.module('./approval', { exports: { refusePlanning } });

// the session file is tested on its own - here it only has to be told
const setSessionCheck = mock.fn<(command?: string) => void>();

mock.module('./session', { exports: { setSessionCheck } });

// the command never really runs: each test says what it prints and how it
// ends, and whether it ends at all before it is killed
type Outcome = { code?: number; signal?: string; error?: string };
let output = '';
let outcome: Outcome = { code: 0 };
let hangs = false;
const killTree = mock.fn<(child: unknown) => void>();
const spawnCommand = mock.fn(
  ({ onData }: { command: string; onData: (chunk: string) => void }) => {
    let settle!: (outcome: Outcome) => void;
    const finished = new Promise<Outcome>((resolve) => {
      settle = resolve;
    });
    const child = { pid: 1 };

    killTree.mock.mockImplementation(() => settle({ signal: 'SIGTERM' }));

    if (output) {
      onData(output);
    }

    if (!hangs) {
      settle(outcome);
    }

    return { child, finished };
  }
);

mock.module('./jobs', { exports: { killTree, spawnCommand } });

const { turn } = await import('./turn');
const { client } = await import('./client');
const {
  check,
  checkPrompt,
  describeCheck,
  parseCommand,
  restoreCheck,
  runCheck,
  setCheck
} = await import('./check');

// the server, as far as check mode can tell. each test says what it answers
let reply: string | Error = 'yarn test';
const chat = mock.method(
  client as unknown as { chat: (request: ChatRequest) => Promise<unknown> },
  'chat',
  async () => {
    if (reply instanceof Error) {
      throw reply;
    }

    return { message: { role: 'assistant', content: reply } };
  }
);

const stripColor = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, '');

describe('check', () => {
  before(() => {
    const project = resolve(root, 'project');

    mkdirSync(resolve(project, 'src'), { recursive: true });
    writeFileSync(
      resolve(project, 'package.json'),
      '{ "scripts": { "test": "node --test" } }'
    );
    process.chdir(project);
  });

  after(() => {
    process.chdir(original);
  });

  beforeEach(() => {
    check.command = undefined;
    check.status = undefined;
    planning = false;
    reply = 'yarn test';
    output = '';
    outcome = { code: 0 };
    hangs = false;
    turn.yieldToUser = false;

    for (const fn of [
      chat,
      spawnCommand,
      killTree,
      setSessionCheck,
      watchForInterrupt,
      stopWatching
    ]) {
      fn.mock.resetCalls();
    }
  });

  describe('parseCommand', () => {
    test('takes a bare command as it is', () => {
      assert.equal(parseCommand('yarn test\n'), 'yarn test');
    });

    test('unwraps a code fence and backticks', () => {
      assert.equal(parseCommand('```sh\nnpm run lint\n```'), 'npm run lint');
      assert.equal(parseCommand('`cargo test`'), 'cargo test');
    });

    test('keeps only the first line of a reply that explains itself', () => {
      assert.equal(
        parseCommand('make check\nThis runs the linter and tests.'),
        'make check'
      );
    });

    test('treats NONE and an empty reply as no command', () => {
      assert.equal(parseCommand('NONE'), undefined);
      assert.equal(parseCommand('none'), undefined);
      assert.equal(parseCommand('  \n'), undefined);
    });
  });

  describe('describeCheck', () => {
    test('shows nothing while check mode is off', () => {
      assert.equal(describeCheck(), '');
    });

    test('shows a placeholder until the check has run', () => {
      check.command = 'yarn test';

      assert.equal(stripColor(describeCheck()), '[·]');
    });

    test('shows a pass and a fail', () => {
      check.command = 'yarn test';
      check.status = 'pass';
      assert.equal(stripColor(describeCheck()), '[✔]');

      check.status = 'fail';
      assert.equal(stripColor(describeCheck()), '[✘]');
    });
  });

  describe('setCheck', () => {
    test('asks the model for a command and saves it with the session', async () => {
      check.status = 'fail';

      await setCheck('on');

      assert.equal(check.command, 'yarn test');
      assert.equal(check.status, undefined);
      assert.deepEqual(setSessionCheck.mock.calls[0].arguments, ['yarn test']);

      const [request] = chat.mock.calls[0].arguments;
      const [message] = request.messages!;

      assert.equal(request.tools, undefined);
      assert.ok(message.content.startsWith(checkPrompt));
      assert.match(message.content, /src\//);
      assert.match(message.content, /Contents of package\.json:/);
      assert.match(message.content, /node --test/);
    });

    test('stays off when the model finds nothing', async () => {
      reply = 'NONE';

      await setCheck('on');

      assert.equal(check.command, undefined);
      assert.equal(setSessionCheck.mock.callCount(), 0);
    });

    test('stays off when the model call fails', async () => {
      reply = new Error('connection refused');

      await setCheck('on');

      assert.equal(check.command, undefined);
      assert.equal(setSessionCheck.mock.callCount(), 0);
    });

    test('turns off and clears the session', async () => {
      check.command = 'yarn test';
      check.status = 'pass';

      await setCheck('off');

      assert.equal(check.command, undefined);
      assert.equal(check.status, undefined);
      assert.deepEqual(setSessionCheck.mock.calls[0].arguments, [undefined]);
    });

    test('takes anything but on or off as the command itself', async () => {
      check.command = 'yarn test';
      check.status = 'fail';

      await setCheck('yarn lint --fix');

      assert.equal(check.command, 'yarn lint --fix');
      assert.equal(check.status, undefined);
      assert.equal(chat.mock.callCount(), 0);
      assert.deepEqual(setSessionCheck.mock.calls[0].arguments, [
        'yarn lint --fix'
      ]);
    });

    test('changes nothing when given no argument', async () => {
      check.command = 'yarn test';

      await setCheck();

      assert.equal(check.command, 'yarn test');
      assert.equal(chat.mock.callCount(), 0);
      assert.equal(setSessionCheck.mock.callCount(), 0);
    });
  });

  describe('restoreCheck', () => {
    test('takes the command back without asking the model', () => {
      check.status = 'fail';

      restoreCheck('make check');

      assert.equal(check.command, 'make check');
      assert.equal(check.status, undefined);
      assert.equal(chat.mock.callCount(), 0);
      assert.equal(setSessionCheck.mock.callCount(), 0);
    });

    test('turns check mode off for a session that had none', () => {
      check.command = 'yarn test';

      restoreCheck(undefined);

      assert.equal(check.command, undefined);
    });
  });

  describe('runCheck', () => {
    test('does nothing while check mode is off', async () => {
      await runCheck();

      assert.equal(spawnCommand.mock.callCount(), 0);
    });

    test('passes when the command exits cleanly', async () => {
      check.command = 'yarn test';

      await runCheck();

      assert.equal(check.status, 'pass');
      assert.equal(
        spawnCommand.mock.calls[0].arguments[0].command,
        'yarn test'
      );
      assert.equal(stopWatching.mock.callCount(), 1);
    });

    test('fails when the command exits non-zero', async () => {
      check.command = 'yarn test';
      output = 'not ok 1 - adds\n';
      outcome = { code: 1 };

      await runCheck();

      assert.equal(check.status, 'fail');
    });

    test('fails when the command cannot be started', async () => {
      check.command = 'nope';
      outcome = { error: 'spawn ENOENT' };

      await runCheck();

      assert.equal(check.status, 'fail');
    });

    test('fails and kills the command when escape is pressed', async () => {
      check.command = 'yarn test';
      hangs = true;

      const running = runCheck();

      // the command is started on the next tick
      await new Promise((resolve) => setImmediate(resolve));
      pressEscape?.();
      await running;

      assert.equal(killTree.mock.callCount(), 1);
      assert.equal(check.status, 'fail');
    });

    test('is skipped in plan mode', async () => {
      check.command = 'yarn test';
      check.status = 'pass';
      planning = true;

      await runCheck();

      assert.equal(check.status, undefined);
      assert.equal(spawnCommand.mock.callCount(), 0);
    });

    test('does not leave a stop answer to cut the next turn short', async () => {
      check.command = 'yarn test';
      // what the approval prompt leaves behind on a stop answer during the turn
      turn.yieldToUser = true;

      await runCheck();

      assert.equal(turn.yieldToUser, false);
    });
  });
});
