import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';

const root = mkdtempSync(resolve(tmpdir(), 'agentiq-checkpoints-'));

process.env.AQ_HOME = resolve(root, 'state');

const { changes, discardCheckpoints, record, undo } =
  await import('./checkpoints');

const workspace = resolve(root, 'workspace');

const file = (name: string) => resolve(workspace, name);
const read = (name: string) => readFileSync(file(name)).toString();

// what write and patch do: snapshot, then write
const writeThrough = (name: string, contents: string) => {
  record(file(name));
  writeFileSync(file(name), contents);
};

before(() => {
  mkdirSync(workspace, { recursive: true });
});

beforeEach(() => {
  discardCheckpoints();
  rmSync(workspace, { recursive: true, force: true });
  mkdirSync(workspace, { recursive: true });
});

describe('undo', () => {
  test('says so when there is nothing to undo', () => {
    assert.match(undo(), /nothing to undo/);
  });

  test('puts back what a change overwrote', () => {
    writeFileSync(file('a.txt'), 'original');
    writeThrough('a.txt', 'changed');

    assert.equal(read('a.txt'), 'changed');

    undo();

    assert.equal(read('a.txt'), 'original');
  });

  test('removes a file the session created', () => {
    // restoring it to nothing would leave an empty file where there was none
    writeThrough('new.txt', 'brand new');

    assert.ok(existsSync(file('new.txt')));

    assert.match(undo(), /Removed/);
    assert.equal(existsSync(file('new.txt')), false);
  });

  test('walks backwards one change at a time', () => {
    writeFileSync(file('a.txt'), 'first');
    writeThrough('a.txt', 'second');
    writeThrough('a.txt', 'third');

    undo();
    assert.equal(read('a.txt'), 'second');

    undo();
    assert.equal(read('a.txt'), 'first');
  });

  test('unwinds changes across several files in the order they were made', () => {
    writeFileSync(file('a.txt'), 'a original');
    writeFileSync(file('b.txt'), 'b original');
    writeThrough('a.txt', 'a changed');
    writeThrough('b.txt', 'b changed');

    undo();

    assert.equal(read('b.txt'), 'b original');
    assert.equal(read('a.txt'), 'a changed', 'only the last change goes back');

    undo();

    assert.equal(read('a.txt'), 'a original');
  });

  test('runs out rather than undoing something twice', () => {
    writeFileSync(file('a.txt'), 'original');
    writeThrough('a.txt', 'changed');

    undo();

    assert.match(undo(), /nothing to undo/);
    assert.equal(read('a.txt'), 'original');
  });

  test('restores a file that was deleted after the change', () => {
    writeFileSync(file('a.txt'), 'original');
    writeThrough('a.txt', 'changed');
    rmSync(file('a.txt'));

    undo();

    assert.equal(read('a.txt'), 'original');
  });
});

describe('changes', () => {
  test('says so when nothing has been written', () => {
    assert.match(changes(), /Nothing has been written/);
  });

  test('lists what was written, newest first', () => {
    writeFileSync(file('a.txt'), 'original');
    writeThrough('a.txt', 'changed');
    writeThrough('b.txt', 'new file');

    const listed = changes();

    assert.ok(listed.indexOf('b.txt') < listed.indexOf('a.txt'));
  });

  test('marks a file the session created', () => {
    writeThrough('new.txt', 'brand new');

    assert.match(changes(), /new\.txt \(created\)/);
  });

  test('does not mark a file that was only edited', () => {
    writeFileSync(file('a.txt'), 'original');
    writeThrough('a.txt', 'changed');

    assert.doesNotMatch(changes(), /\(created\)/);
  });

  test('shrinks as changes are undone', () => {
    writeFileSync(file('a.txt'), 'original');
    writeThrough('a.txt', 'changed');
    undo();

    assert.match(changes(), /Nothing has been written/);
  });
});
