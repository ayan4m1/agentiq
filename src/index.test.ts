import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

// the entrypoint parses argv and dispatches as it is evaluated, so it can only
// be run, not imported - with the same resolver hook the tests themselves use
const register = new URL('../test/register.mjs', import.meta.url).href;
const entrypoint = fileURLToPath(new URL('./index.ts', import.meta.url));

const run = (...args: string[]) =>
  execFileSync(process.execPath, ['--import', register, entrypoint, ...args], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30000
  });

describe('agentiq', () => {
  test('describes itself', () => {
    assert.match(run('--help'), /Service-based AI agent/);
  });

  test('offers the run command', () => {
    assert.match(run('--help'), /run\s+Start the service in the foreground/);
  });
});
