import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';

import { applyEdits, collectEdits, countOccurrences, handler } from './patch';
import { approval } from '../modules/approval';
import { ApprovalMode } from '../types';

const root = mkdtempSync(resolve(tmpdir(), 'agentiq-patch-'));
let seq = 0;

// a fresh file per test, so one that writes cannot affect the next
const fileWith = (contents: string) => {
  const path = resolve(root, `subject-${seq++}.txt`);

  writeFileSync(path, contents);

  return path;
};

const read = (path: string) => readFileSync(path).toString();

// renderDiff prints the hunks it is about to apply, which is the point of it
// in the REPL and only noise here
const quietly = async <T>(work: () => Promise<T>) => {
  const spoke = console.log;

  console.log = () => {};

  try {
    return await work();
  } finally {
    console.log = spoke;
  }
};

afterEach(() => {
  approval.mode = ApprovalMode.Manual;
});

describe('countOccurrences', () => {
  test('counts separated occurrences', () => {
    assert.equal(countOccurrences('a b a b a', 'a'), 3);
  });

  test('returns zero when the needle is absent', () => {
    assert.equal(countOccurrences('abc', 'z'), 0);
  });

  test('counts non-overlapping matches only', () => {
    // advancing by the length of the needle is what makes this 2 rather than 3
    assert.equal(countOccurrences('aaaa', 'aa'), 2);
    assert.equal(countOccurrences('aaa', 'aa'), 1);
  });

  test('counts a multi-line needle', () => {
    assert.equal(countOccurrences('one\ntwo\none\ntwo\n', 'one\ntwo'), 2);
  });
});

describe('handler', () => {
  test('refuses outright in plan mode without touching the file', async () => {
    const path = fileWith('original');

    approval.mode = ApprovalMode.Plan;

    const result = await handler({
      path,
      oldText: 'original',
      newText: 'changed'
    });

    assert.match(String(result), /Plan mode is active/);
    // it must point at the way forward, not just say no
    assert.match(String(result), /present_plan/);
    assert.equal(read(path), 'original');
  });

  test('reports a file that is not there', async () => {
    const result = await handler({
      path: resolve(root, 'absent.txt'),
      oldText: 'a',
      newText: 'b'
    });

    assert.match(String(result), /does not exist/);
  });

  test('refuses when the snippet does not appear, and says to re-read', async () => {
    const path = fileWith('original');

    const result = await handler({
      path,
      oldText: 'missing',
      newText: 'changed'
    });

    assert.match(String(result), /does not appear/);
    assert.match(String(result), /Read the file again/);
    assert.equal(read(path), 'original');
  });

  test('refuses an ambiguous snippet rather than guessing which one', async () => {
    const path = fileWith('x\nx\nx\n');

    const result = await handler({ path, oldText: 'x', newText: 'y' });

    // replacing the wrong one of several identical snippets is a silent
    // corruption, so the count has to come back instead
    assert.match(String(result), /appears 3 times/);
    assert.match(String(result), /no change was made/);
    assert.match(String(result), /replaceAll/);
    assert.equal(read(path), 'x\nx\nx\n');
  });

  test('replaces a unique snippet once approved', async () => {
    const path = fileWith('keep original keep');

    approval.mode = ApprovalMode.Auto;

    const result = await quietly(() =>
      handler({ path, oldText: 'original', newText: 'changed' })
    );

    assert.match(String(result), /Replaced 1 occurrence/);
    assert.equal(read(path), 'keep changed keep');
  });

  test('replaces every occurrence when asked to', async () => {
    const path = fileWith('x\nx\nx\n');

    approval.mode = ApprovalMode.Auto;

    const result = await quietly(() =>
      handler({ path, oldText: 'x', newText: 'y', replaceAll: true })
    );

    assert.match(String(result), /Replaced 3 occurrence/);
    assert.equal(read(path), 'y\ny\ny\n');
  });

  test('does not return the file body, which the model already has', async () => {
    const path = fileWith('secret marker here');

    approval.mode = ApprovalMode.Auto;

    const result = await quietly(() =>
      handler({ path, oldText: 'secret marker', newText: 'other text' })
    );

    // handing back both versions would spend the context twice over
    assert.doesNotMatch(String(result), /other text/);
  });
});

describe('collectEdits', () => {
  test('takes a single replacement as a batch of one', () => {
    const result = collectEdits({ oldText: 'a', newText: 'b' });

    assert.deepEqual(result, [
      { oldText: 'a', newText: 'b', replaceAll: false }
    ]);
  });

  test('takes a batch as it stands', () => {
    const result = collectEdits({
      edits: [
        { oldText: 'a', newText: 'b' },
        { oldText: 'c', newText: 'd', replaceAll: true }
      ]
    });

    assert.equal((result as unknown[]).length, 2);
  });

  test('prefers edits when both forms are given', () => {
    const result = collectEdits({
      oldText: 'ignored',
      newText: 'ignored',
      edits: [{ oldText: 'a', newText: 'b' }]
    });

    assert.deepEqual(result, [
      { oldText: 'a', newText: 'b', replaceAll: false }
    ]);
  });

  test('explains itself when neither form is usable', () => {
    assert.match(String(collectEdits({})), /oldText and newText/);
  });

  test('rejects an entry that is not an object', () => {
    assert.match(String(collectEdits({ edits: ['nonsense'] })), /Entry 1/);
  });

  test('names the entry that is missing a field', () => {
    const result = collectEdits({
      edits: [{ oldText: 'a', newText: 'b' }, { oldText: 'c' }]
    });

    assert.match(String(result), /Entry 2/);
    assert.match(String(result), /oldText and newText/);
  });

  test('treats an empty edits array as no batch at all', () => {
    // an empty array with no oldText is a call that asked for nothing
    assert.match(String(collectEdits({ edits: [] })), /oldText and newText/);
  });
});

describe('applyEdits', () => {
  const edit = (oldText: string, newText: string, replaceAll = false) => ({
    oldText,
    newText,
    replaceAll
  });

  test('applies edits in order', () => {
    const result = applyEdits(
      'one two',
      [edit('one', '1'), edit('two', '2')],
      'f'
    );

    assert.equal(typeof result === 'string' ? result : result.text, '1 2');
  });

  test('lets a later edit see what an earlier one wrote', () => {
    const result = applyEdits('a', [edit('a', 'b'), edit('b', 'c')], 'f');

    assert.equal(typeof result === 'string' ? result : result.text, 'c');
  });

  test('changes nothing at all when one edit cannot be placed', () => {
    const result = applyEdits(
      'one two',
      [edit('one', '1'), edit('nope', 'x')],
      'f'
    );

    // the caller writes nothing on a string, so the file keeps its old contents
    assert.equal(typeof result, 'string');
    assert.match(String(result), /edit 2 of 2/);
  });

  test('refuses an ambiguous edit inside a batch', () => {
    const result = applyEdits('x x', [edit('x', 'y')], 'f');

    assert.match(String(result), /appears 2 times/);
  });

  test('does not number a lone edit as though it were a batch', () => {
    assert.doesNotMatch(
      String(applyEdits('a', [edit('z', 'y')], 'f')),
      /edit 1 of/
    );
  });

  test('counts every replacement it made', () => {
    const result = applyEdits(
      'x x y',
      [edit('x', 'z', true), edit('y', 'w')],
      'f'
    );

    assert.equal(typeof result === 'string' ? -1 : result.replacements, 3);
  });

  test('treats a dollar sign in the replacement as text', () => {
    // String.replace reads $& as an instruction, which would silently mangle
    // any code that contains one
    const result = applyEdits('const a = MARK;', [edit('MARK', '"$&"')], 'f');

    assert.equal(
      typeof result === 'string' ? result : result.text,
      'const a = "$&";'
    );
  });

  test('treats a numbered group in the replacement as text too', () => {
    const result = applyEdits('MARK', [edit('MARK', '$1 and $2')], 'f');

    assert.equal(
      typeof result === 'string' ? result : result.text,
      '$1 and $2'
    );
  });
});

describe('handler with a batch', () => {
  test('applies every edit behind one approval', async () => {
    const path = fileWith('alpha beta gamma');

    approval.mode = ApprovalMode.Auto;

    const result = await quietly(() =>
      handler({
        path,
        edits: [
          { oldText: 'alpha', newText: 'one' },
          { oldText: 'gamma', newText: 'three' }
        ]
      })
    );

    assert.match(String(result), /Replaced 2 occurrence/);
    assert.equal(read(path), 'one beta three');
  });

  test('leaves the file untouched when any edit fails', async () => {
    const path = fileWith('alpha beta');

    approval.mode = ApprovalMode.Auto;

    const result = await quietly(() =>
      handler({
        path,
        edits: [
          { oldText: 'alpha', newText: 'one' },
          { oldText: 'missing', newText: 'two' }
        ]
      })
    );

    assert.match(String(result), /does not appear/);
    assert.equal(read(path), 'alpha beta');
  });

  test('refuses a call that asked for nothing, before touching disk', async () => {
    const result = await handler({ path: resolve(root, 'absent.txt') });

    // the missing-arguments message, not the missing-file one
    assert.match(String(result), /oldText and newText/);
  });
});
