import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { recoverToolCalls } from './recover';

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
