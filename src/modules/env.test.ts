import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';

// the module does all its work as it is evaluated, and it is only evaluated
// once per URL - a query string makes each import below a fresh evaluation
const load = (tag: string) =>
  import(new URL(`./env.ts?${tag}`, import.meta.url).href);

const root = mkdtempSync(resolve(tmpdir(), 'agentiq-env-'));
const withFile = resolve(root, 'with-file');
const withoutFile = resolve(root, 'without-file');
const original = process.cwd();
const marker = 'AQ_TEST_ENV_MARKER';

mkdirSync(withFile);
mkdirSync(withoutFile);
writeFileSync(resolve(withFile, '.env'), `${marker}=loaded\n`);

after(() => {
  process.chdir(original);
  delete process.env[marker];
});

describe('env', () => {
  test('loads a .env file from the working directory', async () => {
    process.chdir(withFile);
    await load('with-file');

    assert.equal(process.env[marker], 'loaded');
  });

  test('carries on with the environment as it is when there is no .env', async () => {
    delete process.env[marker];
    process.chdir(withoutFile);

    await assert.doesNotReject(load('without-file'));
    assert.equal(process.env[marker], undefined);
  });
});
