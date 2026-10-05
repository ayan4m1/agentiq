import { test, describe, afterEach, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';

import { ApprovalAnswer, ApprovalMode } from '../types';
import {
  fakeInquirerCore,
  fakePrompts,
  queue
} from '../../test/fakes/inquirer';

const root = mkdtempSync(resolve(tmpdir(), 'agentiq-write-'));

// checkpoints and approval rules live under the home directory, which has to
// point somewhere disposable before either module is evaluated
process.env.AQ_HOME = resolve(root, 'state');

// the approval prompt and the editor both read the real terminal, so each is
// replaced by one that answers whatever a test says to
const { answer, exports: core } = fakeInquirerCore();
const {
  editor,
  input,
  exports: prompts
} = fakePrompts({
  editor: mock.fn<(config: Record<string, unknown>) => Promise<string>>(),
  input: mock.fn<() => Promise<string>>(async () => '')
});

mock.module('@inquirer/core', { exports: core });
mock.module('@inquirer/prompts', { exports: prompts });

const { definition, handler, unescapeContent } = await import('./write');
const { approval } = await import('../modules/approval');
const { beginTurn, countSince, discardCheckpoints, rewind } =
  await import('../modules/checkpoints');
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
    assert.deepEqual([...(parameters?.required ?? [])].sort(), [
      'content',
      'path'
    ]);
    assert.equal(parameters?.properties?.path.type, 'string');
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

    const turn = beginTurn();

    await quietly(() => handler({ path, content: 'changed' }));
    rewind(turn);

    assert.equal(read(path), 'original');
  });

  test('records a new file so undoing removes it', async () => {
    const path = freshPath();

    approval.mode = ApprovalMode.Auto;

    const turn = beginTurn();

    await quietly(() => handler({ path, content: 'hello' }));
    rewind(turn);

    assert.equal(existsSync(path), false);
  });

  test('records nothing when the write is refused', async () => {
    const path = fileWith('original');

    approval.mode = ApprovalMode.Plan;

    const turn = beginTurn();

    await handler({ path, content: 'changed' });

    assert.equal(countSince(turn), 0);
  });
});

describe('editing before approval', () => {
  beforeEach(() => {
    answer.mock.resetCalls();
    editor.mock.resetCalls();
    input.mock.resetCalls();
  });

  test('offers the content in the editor under the file extension', async () => {
    const path = resolve(root, `edited-${seq++}.ts`);

    queue(answer, [ApprovalAnswer.Edit, ApprovalAnswer.Once]);
    queue(editor, ['const a = 2;\n']);

    await quietly(() => handler({ path, content: 'const a = 1;\n' }));

    const [config] = editor.mock.calls[0].arguments;

    assert.equal(config.default, 'const a = 1;\n');
    assert.equal(config.postfix, '.ts');
  });

  test('writes what the user wrote instead of the proposal', async () => {
    const path = freshPath();

    queue(answer, [ApprovalAnswer.Edit, ApprovalAnswer.Once]);
    queue(editor, ['one\n2\nthree\n']);

    await quietly(() => handler({ path, content: 'one\ntwo\nthree\n' }));

    assert.equal(read(path), 'one\n2\nthree\n');
  });

  test('tells the model what the user changed', async () => {
    const path = freshPath();

    queue(answer, [ApprovalAnswer.Edit, ApprovalAnswer.Once]);
    queue(editor, ['one\n2\nthree\n']);

    const result = await quietly(() =>
      handler({ path, content: 'one\ntwo\nthree\n' })
    );

    assert.match(String(result), /^Wrote 12 bytes to .*\. The user edited it/);
    assert.match(String(result), /-two\n\+2/);
  });

  test('says nothing about an edit that changed nothing', async () => {
    const path = freshPath();

    queue(answer, [ApprovalAnswer.Edit, ApprovalAnswer.Once]);
    queue(editor, ['same\n']);

    const result = await quietly(() => handler({ path, content: 'same\n' }));

    assert.equal(result, `Wrote 5 bytes to ${path}`);
  });

  test('can be undone back to what was there before', async () => {
    const path = fileWith('original');

    queue(answer, [ApprovalAnswer.Edit, ApprovalAnswer.Once]);
    queue(editor, ['edited']);

    const turn = beginTurn();

    await quietly(() => handler({ path, content: 'proposed' }));
    rewind(turn);

    assert.equal(read(path), 'original');
  });

  test('writes nothing when refused after an edit', async () => {
    const path = fileWith('original');

    queue(answer, [ApprovalAnswer.Edit, ApprovalAnswer.No]);
    queue(editor, ['edited']);

    const result = await quietly(() => handler({ path, content: 'proposed' }));

    assert.match(String(result), /declined to write/);
    assert.equal(read(path), 'original');
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
