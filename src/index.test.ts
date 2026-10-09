import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

import type { PackageJson } from './types';

// the entrypoint parses argv and dispatches as it is evaluated, so it can only
// be run, not imported - with the same resolver hook the tests themselves use
const register = new URL('../test/register.mjs', import.meta.url).href;
const entrypoint = fileURLToPath(new URL('./index.ts', import.meta.url));

const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf-8')
) as PackageJson;

const run = (...args: string[]) =>
  execFileSync(process.execPath, ['--import', register, entrypoint, ...args], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30000
  });

describe('agentiq', () => {
  test('reports the version from package.json', () => {
    assert.equal(run('--version').trim(), packageJson.version);
  });

  test('names itself from package.json', () => {
    assert.ok(
      run('--help').startsWith(`Usage: ${packageJson.name} `),
      'usage line should use the package name'
    );
  });

  test('describes itself from package.json', () => {
    assert.ok(run('--help').includes(packageJson.description));
  });

  test('offers the run command', () => {
    assert.match(run('--help'), /run\s+Start the service in the foreground/);
  });

  test('offers the exec command', () => {
    assert.match(
      run('--help'),
      /exec\s+Run a single prompt without interaction/
    );
  });
});
