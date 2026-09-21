import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { recoverToolCalls, validateArgs } from './tools';
import { makeParameter, makeTool } from '../utils';

const toolNames = ['read', 'write', 'patch', 'shell'];

const recover = (content: string) => recoverToolCalls(content, toolNames);

const named = (content: string) =>
  recover(content).calls.map((call) => call.function.name);

describe('recovering qwen XML calls', () => {
  // what qwen3.5 leaves at the bottom of its reply when ollama serves it with a
  // template whose parser does not know the format
  const reply = `I'll read the entry point first to see how it starts up.

<tool_call>
<function=read>
<parameter=path>
src/index.ts
</parameter>
</function>
</tool_call>`;

  test('takes the call from the bottom of the reply', () => {
    const { calls } = recover(reply);

    assert.deepEqual(calls, [
      { function: { name: 'read', arguments: { path: 'src/index.ts' } } }
    ]);
  });

  test('leaves the prose that came before it', () => {
    assert.equal(
      recover(reply).remainder,
      "I'll read the entry point first to see how it starts up."
    );
  });

  test('takes every function in one wrapper', () => {
    const { calls, remainder } = recover(`<tool_call>
<function=read>
<parameter=path>
a.ts
</parameter>
</function>
<function=read>
<parameter=path>
b.ts
</parameter>
</function>
</tool_call>`);

    assert.deepEqual(
      calls.map((call) => call.function.arguments.path),
      ['a.ts', 'b.ts']
    );
    assert.equal(remainder, '');
  });

  test('takes every wrapper', () => {
    const { calls, remainder } = recover(`Two files.

<tool_call>
<function=read>
<parameter=path>
a.ts
</parameter>
</function>
</tool_call>
<tool_call>
<function=shell>
<parameter=command>
ls
</parameter>
</function>
</tool_call>`);

    assert.deepEqual(
      calls.map((call) => call.function.name),
      ['read', 'shell']
    );
    assert.equal(remainder, 'Two files.');
  });

  test('keeps a multi-line value exactly as written', () => {
    const content =
      'export const a = 1;\n\n  if (a < 2 && a > 0) {\n    run();\n  }\n';
    const { calls } = recover(`<tool_call>
<function=write>
<parameter=path>
src/a.ts
</parameter>
<parameter=content>
${content}
</parameter>
</function>
</tool_call>`);

    assert.equal(calls[0].function.arguments.content, content);
  });

  test('lets a value hold markup, even the format itself', () => {
    const content = 'see <function=read> and <parameter=path> and <b>bold</b>';
    const { calls } = recover(`<tool_call>
<function=write>
<parameter=content>
${content}
</parameter>
<parameter=path>
notes.md
</parameter>
</function>
</tool_call>`);

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].function.arguments, {
      content,
      path: 'notes.md'
    });
  });

  test('forgives closing tags cut off by the stop token', () => {
    const { calls, remainder } = recover(`Reading.

<tool_call>
<function=read>
<parameter=path>
src/index.ts`);

    assert.deepEqual(calls[0].function.arguments, { path: 'src/index.ts' });
    assert.equal(remainder, 'Reading.');
  });

  test('ends an unclosed value at the next parameter', () => {
    const { calls } = recover(`<function=patch>
<parameter=path>
a.ts
<parameter=search>
old
</parameter>
</function>`);

    assert.deepEqual(calls[0].function.arguments, {
      path: 'a.ts',
      search: 'old'
    });
  });

  test('takes a function that arrived without its wrapper', () => {
    const { calls, remainder } = recover(`Let me look.
<function=read>
<parameter=path>
a.ts
</parameter>
</function>
</tool_call>`);

    assert.deepEqual(named('<function=read>\n</function>'), ['read']);
    assert.equal(calls[0].function.arguments.path, 'a.ts');
    // the closing wrapper a template left behind goes with the call
    assert.equal(remainder, 'Let me look.');
  });

  test('leaves numbers and booleans for validation to coerce', () => {
    const { calls } = recover(`<tool_call>
<function=read>
<parameter=offset>
10
</parameter>
<parameter=all>
true
</parameter>
</function>
</tool_call>`);

    assert.deepEqual(calls[0].function.arguments, {
      offset: '10',
      all: 'true'
    });
  });

  test('takes an unknown name, so the model can be told the real ones', () => {
    assert.deepEqual(
      named('<tool_call>\n<function=nope>\n</function>\n</tool_call>'),
      ['nope']
    );
  });

  test('keeps text written after the call', () => {
    const { remainder } = recover(
      'Before.\n<function=read>\n<parameter=path>\na.ts\n</parameter>\n</function>\nAfter.'
    );

    assert.equal(remainder, 'Before.\n\nAfter.');
  });
});

describe('recovering JSON calls', () => {
  test('takes a call in tags', () => {
    const { calls, remainder } = recover(
      'On it.\n<tool_call>\n{"name": "read", "arguments": {"path": "a.ts"}}\n</tool_call>'
    );

    assert.deepEqual(calls, [
      { function: { name: 'read', arguments: { path: 'a.ts' } } }
    ]);
    assert.equal(remainder, 'On it.');
  });

  test('takes every tagged call, including one left unclosed', () => {
    assert.deepEqual(
      named(
        '<tool_call>{"name": "read", "arguments": {}}</tool_call>\n<tool_call>{"name": "shell", "arguments": {}}'
      ),
      ['read', 'shell']
    );
  });

  test('looks inside a fence inside the tags', () => {
    assert.deepEqual(
      named(
        '<tool_call>\n```json\n{"name": "read", "arguments": {}}\n```\n</tool_call>'
      ),
      ['read']
    );
  });

  test('takes an unknown name in tags', () => {
    assert.deepEqual(named('<tool_call>{"name": "nope"}</tool_call>'), [
      'nope'
    ]);
  });

  test('takes a call in a fence', () => {
    const { calls, remainder } = recover(
      'Reading it now.\n\n```json\n{"name": "read", "arguments": {"path": "a.ts"}}\n```'
    );

    assert.equal(calls[0].function.arguments.path, 'a.ts');
    assert.equal(remainder, 'Reading it now.');
  });

  test('takes a call from a fence labelled for calls, or not at all', () => {
    assert.deepEqual(named('```tool_code\n{"name": "read"}\n```'), ['read']);
    assert.deepEqual(named('```\n{"name": "read"}\n```'), ['read']);
  });

  test('ignores a fence written in some other language', () => {
    assert.deepEqual(named('```ts\n{"name": "read"}\n```'), []);
  });

  test('ignores a fence naming a tool that does not exist', () => {
    assert.deepEqual(
      named('```json\n{"name": "Alice", "arguments": {}}\n```'),
      []
    );
  });

  test('takes a reply that is nothing but a call', () => {
    const { calls, remainder } = recover(
      '  {"name": "shell", "parameters": {"command": "ls"}}\n'
    );

    assert.deepEqual(calls[0].function, {
      name: 'shell',
      arguments: { command: 'ls' }
    });
    assert.equal(remainder, '');
  });

  test('takes a reply that is nothing but a list of calls', () => {
    assert.deepEqual(
      named(
        '[{"name": "read", "arguments": {}}, {"name": "shell", "arguments": {}}]'
      ),
      ['read', 'shell']
    );
  });

  test('takes mistral calls, prefix and all', () => {
    assert.deepEqual(
      named('[TOOL_CALLS][{"name": "read", "arguments": {"path": "a.ts"}}]'),
      ['read']
    );
  });

  test('ignores a bare object naming a tool that does not exist', () => {
    assert.deepEqual(named('{"name": "Alice", "age": 3}'), []);
  });

  test('understands the ways model families spell a call', () => {
    for (const spelling of [
      { name: 'read', arguments: { path: 'a' } },
      { tool: 'read', args: { path: 'a' } },
      { tool_name: 'read', input: { path: 'a' } },
      { function: 'read', parameters: { path: 'a' } },
      { type: 'function', function: { name: 'read', arguments: { path: 'a' } } }
    ]) {
      assert.deepEqual(recover(JSON.stringify(spelling)).calls, [
        { function: { name: 'read', arguments: { path: 'a' } } }
      ]);
    }
  });

  test('unwraps arguments sent as JSON in a string', () => {
    const { calls } = recover(
      JSON.stringify({
        function: { name: 'read', arguments: '{"path": "a.ts"}' }
      })
    );

    assert.deepEqual(calls[0].function.arguments, { path: 'a.ts' });
  });

  test('passes on arguments that will not parse, for validation to explain', () => {
    const { calls } = recover('{"name": "read", "arguments": "a.ts"}');

    assert.equal(calls[0].function.arguments, 'a.ts');
  });

  test('gives a call with no arguments an empty set', () => {
    assert.deepEqual(
      recover('{"name": "read"}').calls[0].function.arguments,
      {}
    );
  });
});

describe('recovering nothing', () => {
  test('from prose', () => {
    const content = 'The config is loaded in src/modules/config.ts.';

    assert.deepEqual(recover(content), { calls: [], remainder: content });
  });

  test('from prose that happens to contain JSON', () => {
    assert.deepEqual(
      named('Set it like this: {"name": "read", "arguments": {}} and restart.'),
      []
    );
  });

  test('from JSON with no name in it', () => {
    assert.deepEqual(named('{"arguments": {"path": "a.ts"}}'), []);
    assert.deepEqual(named('<tool_call>{"path": "a.ts"}</tool_call>'), []);
  });

  test('from a tag holding something that is not a call', () => {
    assert.deepEqual(named('<tool_call>not json</tool_call>'), []);
  });
});

describe('choosing between formats', () => {
  test('lets tags win over a fence, so nothing is counted twice', () => {
    const { calls } = recover(
      '```json\n{"name": "shell", "arguments": {}}\n```\n<tool_call>{"name": "read", "arguments": {}}</tool_call>'
    );

    assert.deepEqual(
      calls.map((call) => call.function.name),
      ['read']
    );
  });

  test('lets XML win over JSON tags', () => {
    assert.deepEqual(
      named(
        '<tool_call>{"name": "shell"}</tool_call>\n<tool_call>\n<function=read>\n</function>\n</tool_call>'
      ),
      ['read']
    );
  });
});

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
