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

const { beginTurn, changes, countSince, discardCheckpoints, record, rewind } =
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

describe('rewind', () => {
  test('has nothing to do when nothing has been written', () => {
    assert.deepEqual(rewind(beginTurn()), { restored: [] });
  });

  test('puts back what a change overwrote', () => {
    const turn = beginTurn();

    writeFileSync(file('a.txt'), 'original');
    writeThrough('a.txt', 'changed');

    assert.equal(read('a.txt'), 'changed');

    rewind(turn);

    assert.equal(read('a.txt'), 'original');
  });

  test('removes a file the session created', () => {
    const turn = beginTurn();

    // restoring it to nothing would leave an empty file where there was none
    writeThrough('new.txt', 'brand new');

    assert.ok(existsSync(file('new.txt')));

    assert.match(rewind(turn).restored[0], /Removed/);
    assert.equal(existsSync(file('new.txt')), false);
  });

  test('takes a file written twice in one turn back to before the first', () => {
    const turn = beginTurn();

    writeFileSync(file('a.txt'), 'first');
    writeThrough('a.txt', 'second');
    writeThrough('a.txt', 'third');

    assert.equal(rewind(turn).restored.length, 2);
    assert.equal(read('a.txt'), 'first');
  });

  test('takes back later turns along with the one asked for', () => {
    writeFileSync(file('a.txt'), 'a original');
    writeFileSync(file('b.txt'), 'b original');

    const first = beginTurn();

    writeThrough('a.txt', 'a changed');
    beginTurn();
    writeThrough('b.txt', 'b changed');

    rewind(first);

    assert.equal(read('a.txt'), 'a original');
    assert.equal(read('b.txt'), 'b original');
  });

  test('leaves the turns before it alone', () => {
    writeFileSync(file('a.txt'), 'a original');
    writeFileSync(file('b.txt'), 'b original');
    beginTurn();
    writeThrough('a.txt', 'a changed');

    const second = beginTurn();

    writeThrough('b.txt', 'b changed');

    rewind(second);

    assert.equal(read('b.txt'), 'b original');
    assert.equal(read('a.txt'), 'a changed');
  });

  test('runs out rather than restoring something twice', () => {
    const turn = beginTurn();

    writeFileSync(file('a.txt'), 'original');
    writeThrough('a.txt', 'changed');

    rewind(turn);
    writeFileSync(file('a.txt'), 'changed again by hand');

    assert.deepEqual(rewind(turn), { restored: [] });
    assert.equal(read('a.txt'), 'changed again by hand');
  });

  test('restores a file that was deleted after the change', () => {
    const turn = beginTurn();

    writeFileSync(file('a.txt'), 'original');
    writeThrough('a.txt', 'changed');
    rmSync(file('a.txt'));

    rewind(turn);

    assert.equal(read('a.txt'), 'original');
  });

  test('counts the changes a rewind would take back', () => {
    const first = beginTurn();

    writeThrough('a.txt', 'a');
    writeThrough('b.txt', 'b');

    const second = beginTurn();

    writeThrough('c.txt', 'c');

    assert.equal(countSince(first), 3);
    assert.equal(countSince(second), 1);
    assert.equal(countSince(beginTurn()), 0);
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
    const turn = beginTurn();

    writeFileSync(file('a.txt'), 'original');
    writeThrough('a.txt', 'changed');
    rewind(turn);

    assert.match(changes(), /Nothing has been written/);
  });
});
