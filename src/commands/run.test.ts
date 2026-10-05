import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

import type { ModuleMock } from '../../test/fakes/module';

// the command starts a session as it is evaluated, so it is run rather than
// imported - except with startRepl faked out. what happens once it is running
// is covered by modules/interactive.ts and modules/repl.ts - this is only
// whether it gets that far, and how it stops when it cannot
const register = new URL('../../test/register.mjs', import.meta.url).href;
const entrypoint = fileURLToPath(new URL('./run.ts', import.meta.url));
const root = mkdtempSync(resolve(tmpdir(), 'agentiq-run-'));

const run = (...args: string[]) =>
  spawnSync(process.execPath, ['--import', register, entrypoint, ...args], {
    // away from the repository, so a .env there cannot change the outcome
    cwd: root,
    encoding: 'utf-8',
    env: {
      ...process.env,
      AQ_HOME: resolve(root, 'home'),
      // nothing listens on port 1, so the connection is refused straight away
      AQ_OLLAMA_HOST: 'http://127.0.0.1:1'
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30000
  });

describe('run', () => {
  test('describes its options', () => {
    const { status, stdout } = run('--help');

    assert.equal(status, 0);
    assert.match(stdout, /--resume \[id\]/);
  });

  test('stops before asking which model when ollama cannot be reached', () => {
    const { status, stdout, stderr } = run();

    assert.equal(status, 1);
    assert.match(
      stdout + stderr,
      /Could not reach ollama at http:\/\/127\.0\.0\.1:1/
    );
  });

  test('awaits the repl it starts', async () => {
    // the repl never returns on its own, so this one is settled by the test
    let finish = () => {};
    const startRepl = mock.fn(
      () =>
        new Promise<never>((resolve) => {
          finish = () => resolve(undefined as never);
        })
    );
    const interactive = mock.module('../modules/interactive', {
      exports: { startRepl } satisfies ModuleMock<
        typeof import('../modules/interactive')
      >
    });
    const argv = process.argv;

    // commander reads the options from argv, which here belongs to the runner
    process.argv = [process.execPath, entrypoint, '--resume', 'abc'];

    try {
      let loaded = false;
      const loading = import('./run').then(() => {
        loaded = true;
      });

      // a turn of the event loop is enough for the module to reach the await
      await new Promise((resolve) => setImmediate(resolve));

      assert.equal(startRepl.mock.callCount(), 1);
      assert.deepEqual(startRepl.mock.calls[0].arguments, [{ resume: 'abc' }]);
      assert.equal(loaded, false);

      finish();
      await loading;

      assert.equal(loaded, true);
    } finally {
      process.argv = argv;
      interactive.restore();
    }
  });
});
