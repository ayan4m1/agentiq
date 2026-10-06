import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { beginUserTurn, takeYield, turn, yieldToUser } from './turn';

describe('turn', () => {
  beforeEach(() => {
    turn.yieldToUser = false;
  });

  test('clears the search count when the user sends a message', () => {
    turn.searches = 5;
    beginUserTurn();

    assert.equal(turn.searches, 0);
  });

  test('does not yield unless a tool asked it to', () => {
    assert.equal(takeYield(), false);
  });

  test('yields once a tool has asked it to', () => {
    yieldToUser();

    assert.equal(takeYield(), true);
  });

  test('clears the signal when it is read', () => {
    // the signal describes the turn that just finished, not the one after it
    yieldToUser();
    takeYield();

    assert.equal(takeYield(), false);
  });

  test('yields once however many times it was asked', () => {
    yieldToUser();
    yieldToUser();

    assert.equal(takeYield(), true);
    assert.equal(takeYield(), false);
  });
});
