import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

// like commands/run.ts, the command runs as it is evaluated, so it can only be
// run, not imported. the loop it drives is covered by modules/repl.ts - this is
// only whether it gets that far, and how it stops when it cannot
const register = new URL('../../test/register.mjs', import.meta.url).href;
const entrypoint = fileURLToPath(new URL('./exec.ts', import.meta.url));
const root = mkdtempSync(resolve(tmpdir(), 'agentiq-exec-'));

const run = (home: string, ...args: string[]) =>
  spawnSync(process.execPath, ['--import', register, entrypoint, ...args], {
    // away from the repository, so a .env there cannot change the outcome
    cwd: root,
    encoding: 'utf-8',
    env: {
      ...process.env,
      AQ_HOME: resolve(root, home),
      // nothing listens on port 1, so the connection is refused straight away
      AQ_OLLAMA_HOST: 'http://127.0.0.1:1'
    },
    // stdin is not a terminal, and nothing may wait on it
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30000
  });

// a home with a model already chosen, so startup gets as far as the server
const configured = () => {
  const home = resolve(root, 'configured');

  mkdirSync(home, { recursive: true });
  writeFileSync(
    resolve(home, 'models.json'),
    JSON.stringify({
      active: 'gemma4:e4b',
      models: [{ model: 'gemma4:e4b', tokenizer: 'google/gemma-4-E4B' }]
    })
  );

  return 'configured';
};

describe('exec', () => {
  test('describes its arguments and options', () => {
    const { status, stdout } = run('empty', '--help');

    assert.equal(status, 0);
    assert.match(stdout, /<prompt>/);
    assert.match(stdout, /-m, --mode <mode>/);
    assert.match(stdout, /"manual", "auto",\s+"plan"/);
  });

  test('needs a prompt', () => {
    const { status, stderr } = run('empty');

    assert.notEqual(status, 0);
    assert.match(stderr, /missing required argument 'prompt'/);
  });

  test('refuses an approval mode it does not know', () => {
    const { status, stderr } = run('empty', 'hello', '--mode', 'yolo');

    assert.notEqual(status, 0);
    assert.match(stderr, /Allowed choices are manual, auto, plan/);
  });

  test('stops rather than asking when no model has been set up', () => {
    const { status, stdout, stderr } = run('empty', 'hello', '-m', 'auto');

    assert.equal(status, 1);
    assert.match(stdout + stderr, /No model has been set up/);
  });

  test('stops when ollama cannot be reached', () => {
    const { status, stdout, stderr } = run(configured(), 'hello', '-m', 'plan');

    assert.equal(status, 1);
    assert.match(
      stdout + stderr,
      /Could not reach ollama at http:\/\/127\.0\.0\.1:1/
    );
  });
});
