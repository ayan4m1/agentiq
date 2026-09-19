import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { appendOutput, listJobs, readJob, stopJob } from './jobs';
import type { OutputBuffer } from './jobs';

const empty = (): OutputBuffer => ({ buffer: '', cursor: 0, dropped: 0 });

describe('appendOutput', () => {
  test('accumulates while it fits in the budget', () => {
    const target = empty();

    appendOutput(target, 'abc', 10);
    appendOutput(target, 'def', 10);

    assert.equal(target.buffer, 'abcdef');
    assert.equal(target.dropped, 0);
  });

  test('keeps the tail, not the head, once the budget is passed', () => {
    // it is the end of a build output that says what went wrong
    const target = empty();

    appendOutput(target, 'abcdefghij', 4);

    assert.equal(target.buffer, 'ghij');
  });

  test('counts what it dropped so the gap can be reported', () => {
    const target = empty();

    appendOutput(target, 'abcdefghij', 4);

    assert.equal(target.dropped, 6);
  });

  test('accumulates the dropped count across several trims', () => {
    const target = empty();

    appendOutput(target, 'abcdef', 4);
    appendOutput(target, 'ghij', 4);

    assert.equal(target.buffer, 'ghij');
    assert.equal(target.dropped, 6);
  });

  test('moves the cursor back with the text it pointed into', () => {
    const target = empty();

    appendOutput(target, 'abcdef', 10);
    target.cursor = 6;
    // five more characters overflows a ten character budget by one
    appendOutput(target, 'ghijk', 10);

    assert.equal(target.buffer, 'bcdefghijk');
    // the cursor has to follow, or the next read replays output already seen
    assert.equal(target.cursor, 5);
    assert.equal(target.buffer.slice(target.cursor), 'ghijk');
  });

  test('never moves the cursor below zero', () => {
    const target = empty();

    target.cursor = 1;
    appendOutput(target, 'abcdefghij', 2);

    assert.equal(target.cursor, 0);
  });

  test('handles a single chunk larger than the whole budget', () => {
    const target = empty();

    appendOutput(target, 'abcdefghij', 3);

    assert.equal(target.buffer, 'hij');
    assert.equal(target.dropped, 7);
  });
});

describe('looking up a job that is not there', () => {
  test('readJob says so rather than returning nothing', () => {
    assert.match(readJob(999), /no job 999/);
  });

  test('stopJob says so too', () => {
    assert.match(stopJob(999), /no job 999/);
  });

  test('the message explains that none have been started', () => {
    // a bare "not found" leaves the model guessing whether it used a stale id
    assert.match(readJob(999), /no background jobs have been started/);
  });

  test('listJobs reports an empty registry', () => {
    assert.match(listJobs(), /No background jobs have been started/);
  });
});
