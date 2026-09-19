import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { validateArgs } from './validate';
import { makeParameter, makeTool } from '../utils';

// validateArgs reads the parameter list that makeTool registered, so the tool
// under test has to be declared the same way a real one is
makeTool('fixture', 'A tool that exists only for these tests', [
  makeParameter('string', 'text', 'a string'),
  makeParameter('number', 'count', 'a number', false),
  makeParameter('integer', 'index', 'an integer', false),
  makeParameter('boolean', 'flag', 'a boolean', false),
  makeParameter('array', 'items', 'a list of strings', false, 'string'),
  makeParameter('array', 'sizes', 'a list of numbers', false, 'number'),
  makeParameter('array', 'loose', 'an untyped list', false),
  makeParameter('object', 'config', 'an object', false)
]);

const ok = (raw: unknown) => {
  const result = validateArgs('fixture', raw);

  assert.equal(result.ok, true, result.message);

  return result.args as Record<string, unknown>;
};

const fails = (raw: unknown) => {
  const result = validateArgs('fixture', raw);

  assert.equal(result.ok, false, 'expected validation to fail');
  assert.ok(result.message, 'a failure must explain itself to the model');

  return result.message as string;
};

describe('validateArgs', () => {
  test('passes through values that are already the right type', () => {
    assert.deepEqual(ok({ text: 'hello' }), { text: 'hello' });
  });

  test('treats an empty string as a real answer, not a missing one', () => {
    // patch uses one to delete text - if this regresses, deletion breaks
    assert.deepEqual(ok({ text: '' }), { text: '' });
  });

  test('reports a missing required parameter', () => {
    const message = fails({});

    assert.match(message, /text is required/);
    assert.match(message, /a string/);
  });

  test('treats null and undefined as absent rather than as values', () => {
    assert.deepEqual(ok({ text: 'x', count: null, flag: undefined }), {
      text: 'x'
    });
  });

  describe('string', () => {
    test('coerces a number', () => {
      assert.equal(ok({ text: 42 }).text, '42');
    });

    test('coerces a boolean', () => {
      assert.equal(ok({ text: false }).text, 'false');
    });

    test('rejects an object', () => {
      assert.match(fails({ text: { a: 1 } }), /text must be a string/);
    });
  });

  describe('number', () => {
    test('parses a numeric string', () => {
      assert.equal(ok({ text: 'x', count: '3.5' }).count, 3.5);
    });

    test('parses a numeric string for an integer parameter too', () => {
      assert.equal(ok({ text: 'x', index: '7' }).index, 7);
    });

    test('rejects a non-numeric string', () => {
      assert.match(
        fails({ text: 'x', count: 'many' }),
        /count must be a number/
      );
    });

    test('rejects a blank string rather than reading it as zero', () => {
      assert.match(fails({ text: 'x', count: '  ' }), /count must be a number/);
    });

    test('rejects a non-finite number', () => {
      assert.match(
        fails({ text: 'x', count: Infinity }),
        /count must be a number/
      );
    });
  });

  describe('boolean', () => {
    for (const spelling of ['true', 'yes', '1', 'TRUE', ' Yes ']) {
      test(`reads ${JSON.stringify(spelling)} as true`, () => {
        assert.equal(ok({ text: 'x', flag: spelling }).flag, true);
      });
    }

    for (const spelling of ['false', 'no', '0', 'No']) {
      test(`reads ${JSON.stringify(spelling)} as false`, () => {
        assert.equal(ok({ text: 'x', flag: spelling }).flag, false);
      });
    }

    test('rejects anything else', () => {
      assert.match(
        fails({ text: 'x', flag: 'maybe' }),
        /flag must be true or false/
      );
    });
  });

  describe('array', () => {
    test('wraps a lone value in a list', () => {
      assert.deepEqual(ok({ text: 'x', items: 'one' }).items, ['one']);
    });

    test('unwraps a list that arrived as a JSON string', () => {
      assert.deepEqual(ok({ text: 'x', items: '["a","b"]' }).items, ['a', 'b']);
    });

    test('coerces each entry to the declared item type', () => {
      assert.deepEqual(
        ok({ text: 'x', sizes: ['1', 2, '3'] }).sizes,
        [1, 2, 3]
      );
    });

    test('names the offending entry when one will not coerce', () => {
      const message = fails({ text: 'x', sizes: [1, 'nope'] });

      assert.match(message, /sizes must be an array of number/);
      assert.match(message, /entry 2/);
    });

    test('accepts anything when no item type was declared', () => {
      assert.deepEqual(ok({ text: 'x', loose: [1, 'a'] }).loose, [1, 'a']);
    });
  });

  describe('object', () => {
    test('unwraps an object that arrived as a JSON string', () => {
      assert.deepEqual(ok({ text: 'x', config: '{"a":1}' }).config, { a: 1 });
    });

    test('rejects an array', () => {
      assert.match(
        fails({ text: 'x', config: [1] }),
        /config must be an object/
      );
    });
  });

  describe('the argument payload itself', () => {
    test('unwraps a whole argument object sent as a JSON string', () => {
      assert.deepEqual(validateArgs('fixture', '{"text":"hi"}').args, {
        text: 'hi'
      });
    });

    test('rejects a payload that is not an object', () => {
      assert.match(fails([1, 2]), /arguments must be a JSON object/);
    });

    test('treats a missing payload as empty rather than crashing', () => {
      assert.match(fails(undefined), /text is required/);
    });

    test('drops invented parameters instead of failing over them', () => {
      assert.deepEqual(ok({ text: 'x', invented: 'ignore me' }), { text: 'x' });
    });

    test('collects every problem in one message', () => {
      const message = fails({ count: 'many', flag: 'maybe' });

      assert.match(message, /text is required/);
      assert.match(message, /count must be a number/);
      assert.match(message, /flag must be true or false/);
    });
  });

  test('accepts any arguments for a tool that declared none', () => {
    const result = validateArgs('never_registered', { anything: true });

    assert.equal(result.ok, true);
    assert.deepEqual(result.args, {});
  });
});
