import { test, describe, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';

import { ApprovalMode } from '../types';

const root = mkdtempSync(resolve(tmpdir(), 'agentiq-write-'));

// checkpoints and approval rules live under the home directory, which has to
// point somewhere disposable before either module is evaluated
process.env.AQ_HOME = resolve(root, 'state');

const { definition, handler, unescapeContent } = await import('./write');
const { approval } = await import('../modules/approval');
const { discardCheckpoints, undo } = await import('../modules/checkpoints');
const { terminal } = await import('../modules/turn');

let seq = 0;

// a fresh path per test, so one that writes cannot affect the next
const freshPath = () => resolve(root, `subject-${seq++}.txt`);

const fileWith = (contents: string) => {
  const path = freshPath();

  writeFileSync(path, contents);

  return path;
};

const read = (path: string) => readFileSync(path).toString();

// the handler previews the content it is about to write, which is the point
// of it in the REPL and only noise here
const quietly = async <T>(work: () => Promise<T>) => {
  const spoke = console.log;

  console.log = () => {};

  try {
    return await work();
  } finally {
    console.log = spoke;
  }
};

beforeEach(() => {
  discardCheckpoints();
});

afterEach(() => {
  approval.mode = ApprovalMode.Manual;
  terminal.interactive = true;
});

describe('definition', () => {
  test('is a function tool named write', () => {
    assert.equal(definition.type, 'function');
    assert.equal(definition.function.name, 'write');
    assert.ok(definition.function.description);
  });

  test('requires both a path and the content', () => {
    const { parameters } = definition.function;

    assert.notEqual(parameters, undefined);
    assert.deepEqual([...parameters.required].sort(), ['content', 'path']);
    assert.equal(parameters.properties.path.type, 'string');
    assert.equal(parameters.properties.content.type, 'string');
  });
});

describe('handler', () => {
  test('refuses outright in plan mode without touching disk', async () => {
    const path = freshPath();

    approval.mode = ApprovalMode.Plan;

    const result = await handler({ path, content: 'hello' });

    assert.match(String(result), /Plan mode is active/);
    // it must point at the way forward, not just say no
    assert.match(String(result), /present_plan/);
    assert.equal(existsSync(path), false);
  });

  test('refuses an existing file in plan mode and leaves it alone', async () => {
    const path = fileWith('original');

    approval.mode = ApprovalMode.Plan;

    await handler({ path, content: 'changed' });

    assert.equal(read(path), 'original');
  });

  test('creates a new file once approved', async () => {
    const path = freshPath();

    approval.mode = ApprovalMode.Auto;

    const result = await quietly(() => handler({ path, content: 'hello\n' }));

    assert.equal(result, `Wrote 6 bytes to ${path}`);
    assert.equal(read(path), 'hello\n');
  });

  test('overwrites an existing file once approved', async () => {
    const path = fileWith('original');

    approval.mode = ApprovalMode.Auto;

    await quietly(() => handler({ path, content: 'replaced' }));

    assert.equal(read(path), 'replaced');
  });

  test('writes doubly encoded content decoded', async () => {
    const path = freshPath();

    approval.mode = ApprovalMode.Auto;

    const result = await quietly(() =>
      handler({ path, content: 'one\\ntwo\\n' })
    );

    assert.equal(read(path), 'one\ntwo\n');
    // the count is of what landed on disk, not of what the model sent
    assert.match(String(result), /Wrote 8 bytes/);
  });

  test('writes content with real line breaks exactly as given', async () => {
    const path = freshPath();
    const content = 'console.log("a\\nb");\nnext();\n';

    approval.mode = ApprovalMode.Auto;

    await quietly(() => handler({ path, content }));

    assert.equal(read(path), content);
  });

  test('does not return the content, which the model already has', async () => {
    const path = freshPath();

    approval.mode = ApprovalMode.Auto;

    const result = await quietly(() =>
      handler({ path, content: 'secret marker here' })
    );

    assert.doesNotMatch(String(result), /secret marker/);
  });

  test('reports a denial and writes nothing when nobody can approve', async () => {
    const path = fileWith('original');

    // manual mode with nobody at the keyboard is refused rather than prompted
    terminal.interactive = false;

    const result = await quietly(() => handler({ path, content: 'changed' }));

    assert.match(String(result), /declined to write/);
    assert.match(String(result), /non-interactively/);
    assert.equal(read(path), 'original');
  });

  test('records the previous contents so the write can be undone', async () => {
    const path = fileWith('original');

    approval.mode = ApprovalMode.Auto;

    await quietly(() => handler({ path, content: 'changed' }));
    undo();

    assert.equal(read(path), 'original');
  });

  test('records a new file so undoing removes it', async () => {
    const path = freshPath();

    approval.mode = ApprovalMode.Auto;

    await quietly(() => handler({ path, content: 'hello' }));
    undo();

    assert.equal(existsSync(path), false);
  });

  test('records nothing when the write is refused', async () => {
    const path = fileWith('original');

    approval.mode = ApprovalMode.Plan;

    await handler({ path, content: 'changed' });

    assert.match(undo(), /nothing to undo/);
  });
});

describe('unescapeContent', () => {
  test('decodes literal line breaks in doubly encoded content', () => {
    assert.equal(unescapeContent('one\\ntwo\\n'), 'one\ntwo\n');
  });

  test('decodes quotes, tabs and backslashes along with line breaks', () => {
    assert.equal(
      unescapeContent('const a = \\"x\\\\y\\";\\n\\tb();'),
      'const a = "x\\y";\n\tb();'
    );
  });

  test('decodes line breaks even when the rest is not valid JSON', () => {
    assert.equal(unescapeContent('say "hi"\\nbye'), 'say "hi"\nbye');
  });

  test('decodes escaped CRLF line breaks', () => {
    assert.equal(unescapeContent('a\\r\\nb'), 'a\r\nb');
  });

  test('leaves content with real line breaks alone', () => {
    const content = 'console.log("a\\nb");\nnext();\n';

    assert.equal(unescapeContent(content), content);
  });

  test('leaves content without escaped line breaks alone', () => {
    assert.equal(unescapeContent('path\\to\\thing'), 'path\\to\\thing');
  });
});
