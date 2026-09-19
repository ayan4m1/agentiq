import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { toBoolean, toLogLevel, toThink } from './config';
import { LogLevel } from '../types';

// both parsers warn on the console when they reject something, which these
// tests do on purpose
const quietly = <T>(work: () => T) => {
  const spoke = console.warn;

  console.warn = () => {};

  try {
    return work();
  } finally {
    console.warn = spoke;
  }
};

describe('toLogLevel', () => {
  for (const level of Object.values(LogLevel)) {
    test(`accepts ${level}`, () => {
      assert.equal(toLogLevel(level), level);
    });
  }

  test('defaults to info when nothing is set', () => {
    assert.equal(toLogLevel(undefined), LogLevel.Info);
    assert.equal(toLogLevel(''), LogLevel.Info);
  });

  test('falls back rather than going silent on a bad level', () => {
    // winston does not reject an unknown level, it just fails every comparison
    // and logs nothing at all
    assert.equal(
      quietly(() => toLogLevel('verbose')),
      LogLevel.Info
    );
  });

  test('does not accept warning spelled out, which winston calls warn', () => {
    assert.equal(
      quietly(() => toLogLevel('warning')),
      LogLevel.Info
    );
  });
});

describe('toThink', () => {
  test('is undefined when unset, so the field is not sent at all', () => {
    assert.equal(toThink(undefined), undefined);
    assert.equal(toThink(''), undefined);
  });

  for (const spelling of ['true', 'yes', '1', 'TRUE', ' True ']) {
    test(`reads ${JSON.stringify(spelling)} as on`, () => {
      assert.equal(toThink(spelling), true);
    });
  }

  for (const spelling of ['false', 'no', '0', 'False']) {
    test(`reads ${JSON.stringify(spelling)} as off`, () => {
      // an explicit false has to survive, or it could not turn off a default
      assert.equal(toThink(spelling), false);
    });
  }

  for (const level of ['high', 'medium', 'low']) {
    test(`passes ${level} through as a level`, () => {
      assert.equal(toThink(level), level);
    });
  }

  test('accepts a level whatever its case', () => {
    assert.equal(toThink('HIGH'), 'high');
  });

  test('ignores a value ollama would reject', () => {
    // sending one costs every turn of the session, not just the setting
    assert.equal(
      quietly(() => toThink('maximum')),
      undefined
    );
  });
});

describe('toBoolean', () => {
  for (const spelling of ['true', 'yes', '1', 'TRUE', ' yes ']) {
    test(`reads ${JSON.stringify(spelling)} as on`, () => {
      assert.equal(toBoolean(spelling, 'AQ_TEST'), true);
    });
  }

  for (const spelling of ['false', 'no', '0', 'No']) {
    test(`reads ${JSON.stringify(spelling)} as off`, () => {
      assert.equal(toBoolean(spelling, 'AQ_TEST', true), false);
    });
  }

  test('uses the fallback when nothing is set', () => {
    assert.equal(toBoolean(undefined, 'AQ_TEST'), false);
    assert.equal(toBoolean('', 'AQ_TEST', true), true);
  });

  test('keeps the fallback rather than reading a typo as off', () => {
    // a value meaning the opposite of what was written is worse than one that
    // was ignored and said so
    assert.equal(
      quietly(() => toBoolean('ture', 'AQ_TEST', true)),
      true
    );
  });
});
