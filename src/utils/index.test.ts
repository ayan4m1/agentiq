import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { ollama } from '../modules/config';
import {
  describeAge,
  describeElapsed,
  describeError,
  getContentBudget,
  getParameters,
  makeParameter,
  makeTool,
  serializeResult,
  truncate
} from './index';

describe('truncate', () => {
  test('leaves content that fits alone', () => {
    assert.equal(truncate('short', 10), 'short');
  });

  test('leaves content exactly at the budget alone', () => {
    assert.equal(truncate('exactly10!', 10), 'exactly10!');
  });

  test('cuts to the budget and says so', () => {
    const result = truncate('abcdefghij', 4);

    assert.ok(result.startsWith('abcd'));
    // the model has no record of the call that produced a tool result, so a
    // silent cut would read as the whole thing
    assert.match(result, /truncated: showing 4 of 10 characters/);
  });
});

describe('getContentBudget', () => {
  test('is a fraction of the context window in characters', () => {
    assert.equal(
      getContentBudget(0.3),
      Math.floor(ollama.contextLimit * 0.3 * 3.33)
    );
  });

  test('scales with the fraction it is given', () => {
    assert.ok(getContentBudget(0.5) > getContentBudget(0.2));
  });
});

describe('describeAge', () => {
  const ago = (ms: number) => describeAge(Date.now() - ms);

  test('counts seconds below a minute', () => {
    assert.equal(ago(5_000), '5s ago');
  });

  test('rolls over into minutes', () => {
    assert.equal(ago(90_000), '1m ago');
  });

  test('rolls over into hours', () => {
    assert.equal(ago(3 * 3_600_000), '3h ago');
  });

  test('rolls over into days and stops there', () => {
    assert.equal(ago(50 * 86_400_000), '50d ago');
  });

  test('never reports a negative age for a clock skewed forward', () => {
    assert.equal(describeAge(Date.now() + 10_000), '0s ago');
  });
});

describe('describeElapsed', () => {
  test('starts at zero seconds', () => {
    assert.equal(describeElapsed(0), '0s');
  });

  test('counts whole seconds below a minute', () => {
    assert.equal(describeElapsed(59_999), '59s');
  });

  test('keeps the seconds once it rolls over into minutes', () => {
    assert.equal(describeElapsed(90_000), '1m30s');
    assert.equal(describeElapsed(60_000), '1m0s');
  });

  test('keeps every smaller unit once it reaches hours', () => {
    assert.equal(describeElapsed(3_725_000), '1h2m5s');
  });

  test('rolls over into days', () => {
    assert.equal(describeElapsed(90_000_000), '1d1h0m0s');
  });

  test('never reports a negative time', () => {
    assert.equal(describeElapsed(-5_000), '0s');
  });
});

describe('serializeResult', () => {
  test('passes a string through untouched', () => {
    assert.equal(serializeResult('done'), 'done');
  });

  test('encodes anything else as JSON', () => {
    assert.equal(serializeResult({ a: 1 }), '{"a":1}');
  });

  for (const empty of [undefined, null]) {
    test(`reports ${String(empty)} as no output rather than as the word`, () => {
      // the word "undefined" reaching the model reads like a real value
      assert.equal(serializeResult(empty), 'The tool returned no output.');
    });
  }
});

describe('describeError', () => {
  test('takes the message off an Error', () => {
    assert.equal(describeError(new Error('boom')), 'boom');
  });

  test('stringifies anything else', () => {
    assert.equal(describeError('plain'), 'plain');
    assert.equal(describeError(404), '404');
  });
});

describe('makeTool', () => {
  const definition = makeTool('sample', 'A sample tool', [
    makeParameter('string', 'needed', 'a required one'),
    makeParameter('number', 'optional', 'an optional one', false),
    makeParameter('array', 'list', 'a list', false, 'string')
  ]);

  test('lists only the required parameters as required', () => {
    assert.deepEqual(definition.function.parameters?.required, ['needed']);
  });

  test('describes every parameter as a property', () => {
    assert.deepEqual(
      Object.keys(definition.function.parameters?.properties ?? {}),
      ['needed', 'optional', 'list']
    );
  });

  test('carries the element type of an array through', () => {
    const properties = definition.function.parameters?.properties as Record<
      string,
      { items?: { type: string } }
    >;

    assert.deepEqual(properties.list.items, { type: 'string' });
  });

  test('registers the parameters for validation to read back', () => {
    // makeTool is the only place a parameter is declared, so a tool that skips
    // it silently loses all argument checking
    assert.equal(getParameters('sample')?.length, 3);
  });

  test('returns nothing for a tool that was never made', () => {
    assert.equal(getParameters('no_such_tool'), undefined);
  });
});
