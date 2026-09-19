import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';

// the character budget is sized from the context limit when the module is
// evaluated, so shrink it first - 100 tokens is a budget of 99 characters
process.env.AQ_OLLAMA_CONTEXT_LIMIT = '100';

const { handler } = await import('./read');

const root = mkdtempSync(resolve(tmpdir(), 'agentiq-read-'));
const short = resolve(root, 'short.txt');
const long = resolve(root, 'long.txt');
const directory = resolve(root, 'directory');

writeFileSync(short, 'one\ntwo\nthree\nfour');
// ten characters a line comes to seventeen once numbered, so five lines fit
writeFileSync(
  long,
  Array.from(
    { length: 20 },
    (_, i) => `line ${String(i + 1).padStart(5, '0')}`
  ).join('\n')
);
mkdirSync(directory);

describe('read', () => {
  test('numbers every line from one', async () => {
    assert.equal(
      await handler({ path: short }),
      '     1\tone\n     2\ttwo\n     3\tthree\n     4\tfour'
    );
  });

  test('starts from an offset', async () => {
    assert.equal(
      await handler({ path: short, offset: 3 }),
      '     3\tthree\n     4\tfour'
    );
  });

  test('stops at a limit and says where to carry on from', async () => {
    const output = await handler({ path: short, offset: 2, limit: 2 });

    assert.match(output, /^ {5}2\ttwo\n {5}3\tthree\n\n/);
    assert.match(
      output,
      /\[showing lines 2-3 of 4 - call read again with offset 4 for more\]$/
    );
  });

  test('stops on the character budget without cutting a line in half', async () => {
    const output = await handler({ path: long });
    const numbered = output.split('\n\n')[0].split('\n');

    assert.equal(numbered.length, 5);
    assert.equal(numbered[4], '     5\tline 00005');
    assert.match(output, /offset 6 for more\]$/);
  });

  test('refuses an offset past the end', async () => {
    assert.equal(
      await handler({ path: short, offset: 10 }),
      `${short} has only 4 lines - offset 10 is past the end`
    );
  });

  test('says so when the file does not exist', async () => {
    const missing = resolve(root, 'missing.txt');

    assert.equal(
      await handler({ path: missing }),
      `Cannot read ${missing} - it does not exist`
    );
  });

  test('points at the find tool when given a directory', async () => {
    assert.match(
      await handler({ path: directory }),
      /is a directory, not a file - use the find tool/
    );
  });
});
