import { test, describe, before, beforeEach, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import { fakeInterrupt } from '../../test/fakes/interrupt';
import { fakeOra } from '../../test/fakes/ora';
import type { ModuleMock } from '../../test/fakes/module';
import type { ChatProvider } from '../types';

// config reads the home directory as it is evaluated, so it has to point
// somewhere disposable before anything imports it
const root = mkdtempSync(resolve(tmpdir(), 'agentiq-check-'));
const original = process.cwd();

process.env.AQ_HOME = resolve(root, 'home');

const interrupt = fakeInterrupt();

mock.module('./interrupt', { exports: interrupt.exports });
mock.module('ora', { exports: fakeOra().exports });

// the approval mode is whatever the test says it is
let planning = false;
const refusePlanning = mock.fn(() => (planning ? 'refused' : undefined));

mock.module('./approval', {
  exports: { refusePlanning } satisfies ModuleMock<typeof import('./approval')>
});

// the session file is tested on its own - here it only has to be told
const setSessionCheck = mock.fn<(command?: string) => void>();

mock.module('./session', {
  exports: { setSessionCheck } satisfies ModuleMock<typeof import('./session')>
});

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

mock.module('./jobs', {
  exports: { killTree, spawnCommand } satisfies ModuleMock<
    typeof import('./jobs')
  >
});

const { turn } = await import('./turn');
const { chatProvider } = await import('../providers');
const {
  check,
  checkPrompt,
  describeCheck,
  diagnosticsMarker,
  fixPrompt,
  parseCommand,
  restoreCheck,
  runCheck,
  setCheck
} = await import('./check');
const { shell } = await import('./config');

// the server, as far as check mode can tell. each test says what it answers
let reply: string | Error = 'yarn test';
const answer: ChatProvider['complete'] = async () => {
  if (reply instanceof Error) {
    throw reply;
  }

  return { role: 'assistant', content: reply };
};
const complete = mock.method(chatProvider, 'complete', answer);

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
    check.diagnostics = undefined;
    planning = false;
    reply = 'yarn test';
    output = '';
    outcome = { code: 0 };
    hangs = false;
    turn.yieldToUser = false;

    for (const fn of [
      complete,
      spawnCommand,
      killTree,
      setSessionCheck,
      interrupt.watchForInterrupt,
      interrupt.stopWatching
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

      const [request] = complete.mock.calls[0].arguments;
      const [message] = request.messages;

      assert.equal(request.tools, undefined);
      assert.ok(message.content.startsWith(checkPrompt));
      assert.match(message.content, /src\//);
      assert.match(message.content, /Contents of package\.json:/);
      assert.match(message.content, /node --test/);
    });

    test("sends the project's agent instructions along", async () => {
      writeFileSync('AGENTS.md', 'Run `make verify` before committing.');

      try {
        await setCheck('on');
      } finally {
        rmSync('AGENTS.md');
      }

      const [request] = complete.mock.calls[0].arguments;
      const [message] = request.messages;

      assert.match(message.content, /Contents of AGENTS\.md:/);
      assert.match(message.content, /make verify/);
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
      check.diagnostics = 'stale';

      await setCheck('off');

      assert.equal(check.command, undefined);
      assert.equal(check.status, undefined);
      assert.equal(check.diagnostics, undefined);
      assert.deepEqual(setSessionCheck.mock.calls[0].arguments, [undefined]);
    });

    test('takes anything but on or off as the command itself', async () => {
      check.command = 'yarn test';
      check.status = 'fail';

      await setCheck('yarn lint --fix');

      assert.equal(check.command, 'yarn lint --fix');
      assert.equal(check.status, undefined);
      assert.equal(complete.mock.callCount(), 0);
      assert.deepEqual(setSessionCheck.mock.calls[0].arguments, [
        'yarn lint --fix'
      ]);
    });

    test('changes nothing when given no argument', async () => {
      check.command = 'yarn test';

      await setCheck();

      assert.equal(check.command, 'yarn test');
      assert.equal(complete.mock.callCount(), 0);
      assert.equal(setSessionCheck.mock.callCount(), 0);
    });
  });

  describe('restoreCheck', () => {
    test('takes the command back without asking the model', () => {
      check.status = 'fail';
      check.diagnostics = 'stale';

      restoreCheck('make check');

      assert.equal(check.command, 'make check');
      assert.equal(check.status, undefined);
      assert.equal(check.diagnostics, undefined);
      assert.equal(complete.mock.callCount(), 0);
      assert.equal(setSessionCheck.mock.callCount(), 0);
    });

    test('turns check mode off for a session that had none', () => {
      check.command = 'yarn test';

      restoreCheck(undefined);

      assert.equal(check.command, undefined);
    });
  });

  describe('fixPrompt', () => {
    test('names the command and carries the marker', () => {
      assert.equal(
        fixPrompt('yarn test'),
        'Fix the failing check "yarn test" (diagnostics attached)'
      );
      assert.ok(fixPrompt('yarn test').includes(diagnosticsMarker));
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
      assert.equal(interrupt.stopWatching.mock.callCount(), 1);
    });

    test('fails when the command exits non-zero', async () => {
      check.command = 'yarn test';
      output = 'not ok 1 - adds\n';
      outcome = { code: 1 };

      await runCheck();

      assert.equal(check.status, 'fail');
      assert.equal(
        check.diagnostics,
        'yarn test exited with code 1\nnot ok 1 - adds'
      );
    });

    test('keeps only the tail of a long failure', async () => {
      check.command = 'yarn test';
      output = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n');
      outcome = { code: 1 };

      await runCheck();

      const lines = check.diagnostics!.split('\n');

      assert.equal(lines.length, 21);
      assert.equal(lines[1], 'line 11');
      assert.equal(lines.at(-1), 'line 30');
    });

    test('fails when the command cannot be started', async () => {
      check.command = 'nope';
      outcome = { error: 'spawn ENOENT' };

      await runCheck();

      assert.equal(check.status, 'fail');
      assert.equal(
        check.diagnostics,
        'nope could not be started: spawn ENOENT'
      );
    });

    test('forgets an earlier failure once it passes', async () => {
      check.command = 'yarn test';
      check.diagnostics = 'stale';

      await runCheck();

      assert.equal(check.diagnostics, undefined);
    });

    test('fails and kills the command when escape is pressed', async () => {
      check.command = 'yarn test';
      hangs = true;

      const running = runCheck();

      // the command is started on the next tick
      await new Promise((resolve) => setImmediate(resolve));
      interrupt.pressEscape();
      await running;

      assert.equal(killTree.mock.callCount(), 1);
      assert.equal(check.status, 'fail');
    });

    test('fails and kills the command once it runs past the timeout', async () => {
      const { timeout } = shell;

      check.command = 'yarn test';
      hangs = true;
      shell.timeout = 10;

      try {
        await runCheck();
      } finally {
        shell.timeout = timeout;
      }

      assert.equal(killTree.mock.callCount(), 1);
      assert.equal(check.status, 'fail');
      assert.equal(check.diagnostics, 'yarn test timed out after 10ms');
    });

    test('fails when something else kills the command', async () => {
      check.command = 'yarn test';
      outcome = { signal: 'SIGKILL' };

      await runCheck();

      assert.equal(check.status, 'fail');
      assert.equal(check.diagnostics, 'yarn test was killed by SIGKILL');
    });

    test('is skipped in plan mode', async () => {
      check.command = 'yarn test';
      check.status = 'pass';
      planning = true;

      check.diagnostics = 'stale';

      await runCheck();

      assert.equal(check.status, undefined);
      assert.equal(check.diagnostics, undefined);
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
