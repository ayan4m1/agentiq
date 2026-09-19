import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

// the command starts a session as it is evaluated, so it can only be run, not
// imported. what happens once it is running is covered by modules/repl.ts -
// this is only whether it gets that far, and how it stops when it cannot
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
      AQ_OLLAMA_HOST: 'http://127.0.0.1:1',
      AQ_OLLAMA_MODEL: 'test-model'
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

  test('stops before starting a session when ollama cannot be reached', () => {
    const { status, stdout, stderr } = run();

    assert.equal(status, 1);
    assert.match(
      stdout + stderr,
      /Could not reach ollama at http:\/\/127\.0\.0\.1:1/
    );
  });
});
