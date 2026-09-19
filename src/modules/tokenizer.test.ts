import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { estimateTokens } from './tokenizer';
import { charsPerToken } from '../utils';

describe('estimateTokens', () => {
  test('counts nothing for an empty string', () => {
    assert.equal(estimateTokens(''), 0);
  });

  test('divides by the same ratio the content budgets assume', () => {
    const value = 'x'.repeat(1000);

    assert.equal(estimateTokens(value), Math.ceil(1000 / charsPerToken));
  });

  test('never reports zero for content that exists', () => {
    // a message counted as free would be invisible to the compaction trigger
    assert.equal(estimateTokens('a'), 1);
  });

  test('grows with the length of the content', () => {
    assert.ok(estimateTokens('a'.repeat(100)) > estimateTokens('a'.repeat(10)));
  });

  test('stays within a plausible factor of a real tokenizer', () => {
    // prose runs about four characters to the token, so an estimate that is
    // wildly off would push compaction at the wrong time on every turn
    const prose =
      'The quick brown fox jumps over the lazy dog, and then does it again.';
    const estimate = estimateTokens(prose);

    assert.ok(estimate > prose.length / 8, 'should not be wildly low');
    assert.ok(estimate < prose.length / 2, 'should not be wildly high');
  });
});
