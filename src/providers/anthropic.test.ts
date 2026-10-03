import { test, describe, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type Anthropic from '@anthropic-ai/sdk';

import { anthropic, logging } from '../modules/config';
import {
  AnthropicProvider,
  toMessages,
  toReply,
  toThinking,
  toTool
} from './anthropic';
import { Provider, type ChatChunk, type ChatMessage } from '../types';

// a reply as the messages API would send it, with only what a test cares
// about filled in
const reply = (
  content: unknown[],
  extra: Record<string, unknown> = {}
): Anthropic.Message =>
  ({
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5',
    content,
    stop_reason: 'end_turn',
    usage: {
      input_tokens: 100,
      cache_creation_input_tokens: 20,
      cache_read_input_tokens: 300,
      output_tokens: 40
    },
    ...extra
  }) as Anthropic.Message;

const toolUse = (id: string, name = 'read', input = { path: 'a.ts' }) => ({
  type: 'tool_use',
  id,
  name,
  input
});

const native = (content: unknown[]) => ({
  provider: Provider.Anthropic,
  content
});

const controllersOf = (provider: AnthropicProvider) =>
  (provider as unknown as { controllers: AbortController[] }).controllers;

// a server that answers with whatever the test hands it
const fakeClient = (overrides: Record<string, unknown> = {}) => {
  const client = {
    messages: {
      stream: mock.fn<(params: unknown) => unknown>(),
      create: mock.fn<(params: unknown, options?: unknown) => unknown>(),
      countTokens: mock.fn<(params: unknown, options?: unknown) => unknown>()
    },
    models: {
      retrieve: mock.fn<(model: string) => unknown>(),
      list: mock.fn<() => unknown>()
    },
    ...overrides
  };

  return {
    client,
    provider: new AnthropicProvider(client as unknown as Anthropic)
  };
};

// what client.messages.stream hands back: events to iterate, the finished
// message once they are done, and the controller that cancels the request
const fakeStream = (events: unknown[], final: Anthropic.Message) => {
  const controller = new AbortController();

  return {
    controller,
    abort: mock.fn(() => controller.abort()),
    finalMessage: async () => final,
    async *[Symbol.asyncIterator]() {
      yield* events;
    }
  };
};

const textDelta = (text: string) => ({
  type: 'content_block_delta',
  index: 0,
  delta: { type: 'text_delta', text }
});

const thinkingDelta = (thinking: string) => ({
  type: 'content_block_delta',
  index: 0,
  delta: { type: 'thinking_delta', thinking }
});

const collect = async (chunks: AsyncIterable<ChatChunk>) => {
  const all: ChatChunk[] = [];

  for await (const chunk of chunks) {
    all.push(chunk);
  }

  return all;
};

describe('the client it builds', () => {
  const { apiKey, baseUrl } = anthropic;

  afterEach(() => {
    anthropic.apiKey = apiKey;
    anthropic.baseUrl = baseUrl;
  });

  test('uses a configured key', () => {
    anthropic.apiKey = 'sk-ant-test';

    assert.equal(new AnthropicProvider().client.apiKey, 'sk-ant-test');
  });

  test('leaves the key to the SDK when none is configured', () => {
    // an empty string would be taken as the key, and shadow the environment
    // and any profile from `ant auth login`
    anthropic.apiKey = '';

    assert.equal(
      new AnthropicProvider().client.apiKey,
      process.env.ANTHROPIC_API_KEY ?? null
    );
  });

  test('uses a configured base URL', () => {
    anthropic.baseUrl = 'http://localhost:30000';

    assert.equal(
      new AnthropicProvider().client.baseURL,
      'http://localhost:30000'
    );
  });

  test('leaves the base URL to the SDK when none is configured', () => {
    anthropic.baseUrl = '';

    assert.equal(
      new AnthropicProvider().client.baseURL,
      process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com'
    );
  });
});

describe('toMessages', () => {
  test('lifts the system prompt into its own field', () => {
    const { system, messages } = toMessages([
      { role: 'system', content: 'be brief' },
      { role: 'user', content: 'hi' }
    ]);

    assert.equal(system, 'be brief');
    assert.deepEqual(messages, [{ role: 'user', content: 'hi' }]);
  });

  test('sends no system field when there is no system prompt', () => {
    assert.equal(
      toMessages([{ role: 'user', content: 'hi' }]).system,
      undefined
    );
  });

  test('replays an assistant turn from the blocks it arrived as', () => {
    const blocks = [
      { type: 'thinking', thinking: '', signature: 'sig' },
      { type: 'text', text: 'Let me look.' },
      toolUse('toolu_1')
    ];

    const { messages } = toMessages([
      { role: 'user', content: 'what is in a.ts?' },
      {
        // what replayable() leaves of the turn - the blocks are what count
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'toolu_1', function: { name: 'read', arguments: {} } }
        ],
        native: native(blocks)
      }
    ]);

    assert.deepEqual(messages[1], { role: 'assistant', content: blocks });
  });

  test('rebuilds a turn that has no blocks of its own', () => {
    const { messages } = toMessages([
      {
        role: 'assistant',
        content: 'Let me look.',
        tool_calls: [
          {
            id: 'call_1',
            function: { name: 'read', arguments: { path: 'a' } }
          },
          // nothing could ever answer this one by id
          { function: { name: 'list', arguments: {} } }
        ],
        native: { provider: Provider.Ollama, content: 'not ours' }
      }
    ]);

    assert.deepEqual(messages, [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Let me look.' },
          {
            type: 'tool_use',
            id: 'call_1',
            name: 'read',
            input: { path: 'a' }
          }
        ]
      }
    ]);
  });

  test('drops an assistant turn with nothing in it', () => {
    const { messages } = toMessages([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: '' }
    ]);

    assert.deepEqual(messages, [{ role: 'user', content: 'hi' }]);
  });

  test("answers every call of a turn in one message, after the turn's calls", () => {
    const { messages } = toMessages([
      {
        role: 'assistant',
        content: '',
        native: native([toolUse('toolu_1'), toolUse('toolu_2')])
      },
      {
        role: 'tool',
        tool_name: 'read',
        tool_call_id: 'toolu_1',
        content: 'one'
      },
      {
        role: 'tool',
        tool_name: 'read',
        tool_call_id: 'toolu_2',
        content: 'two'
      },
      { role: 'user', content: 'and then?' }
    ]);

    assert.deepEqual(messages.slice(1), [
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_1', content: 'one' },
          { type: 'tool_result', tool_use_id: 'toolu_2', content: 'two' }
        ]
      },
      { role: 'user', content: 'and then?' }
    ]);
  });

  test('passes on a result no call can be found for as text', () => {
    // a call recovered from the reply's text has no id to answer
    const { messages } = toMessages([
      {
        role: 'assistant',
        content: '{"name": "read"}',
        tool_calls: [{ function: { name: 'read', arguments: {} } }]
      },
      { role: 'tool', tool_name: 'read', content: 'contents' },
      // and an id from some other turn is no better
      {
        role: 'tool',
        tool_name: 'list',
        tool_call_id: 'toolu_old',
        content: 'files'
      }
    ]);

    assert.deepEqual(messages[1], {
      role: 'user',
      content: [
        { type: 'text', text: 'Result of read:\ncontents' },
        { type: 'text', text: 'Result of list:\nfiles' }
      ]
    });
  });
});

describe('toTool', () => {
  test('hands the parameter schema over as the input schema', () => {
    assert.deepEqual(
      toTool({
        type: 'function',
        function: {
          name: 'read',
          description: 'Read a file',
          parameters: {
            type: 'object',
            required: ['path'],
            properties: { path: { type: 'string' } }
          }
        }
      }),
      {
        name: 'read',
        description: 'Read a file',
        input_schema: {
          type: 'object',
          required: ['path'],
          properties: { path: { type: 'string' } }
        }
      }
    );
  });

  test('gives a tool with no parameters an empty object schema', () => {
    assert.deepEqual(
      toTool({ type: 'function', function: { name: 'noop' } }).input_schema,
      { type: 'object' }
    );
  });
});

describe('toThinking', () => {
  afterEach(() => {
    logging.logThoughts = false;
  });

  test('leaves the model to its default when nothing is set', () => {
    assert.deepEqual(toThinking(undefined), {});
  });

  test('asks for adaptive thinking when it is on', () => {
    assert.deepEqual(toThinking(true), { thinking: { type: 'adaptive' } });
  });

  test('turns it off when told to', () => {
    assert.deepEqual(toThinking(false), { thinking: { type: 'disabled' } });
  });

  test('takes a level as the effort to put in', () => {
    assert.deepEqual(toThinking('low'), {
      thinking: { type: 'adaptive' },
      output_config: { effort: 'low' }
    });
  });

  test('asks for readable thinking only when it will be shown', () => {
    logging.logThoughts = true;

    assert.deepEqual(toThinking(true), {
      thinking: { type: 'adaptive', display: 'summarized' }
    });
  });
});

describe('toReply', () => {
  test('reads the text, the thinking and the calls out of a reply', () => {
    const content = [
      { type: 'thinking', thinking: 'hmm', signature: 'sig' },
      { type: 'text', text: 'Let me ' },
      { type: 'text', text: 'look.' },
      toolUse('toolu_1')
    ];

    assert.deepEqual(toReply(reply(content, { stop_reason: 'tool_use' })), {
      role: 'assistant',
      content: 'Let me look.',
      thinking: 'hmm',
      tool_calls: [
        {
          id: 'toolu_1',
          function: { name: 'read', arguments: { path: 'a.ts' } }
        }
      ],
      native: native(content)
    });
  });

  for (const stop_reason of ['refusal', 'max_tokens']) {
    test(`never runs a call from a reply that ended in ${stop_reason}`, () => {
      const said = { type: 'text', text: 'Reading' };
      const result = toReply(
        reply([said, toolUse('toolu_1')], { stop_reason })
      );

      assert.equal(result.tool_calls, undefined);
      // a tool_use with no result after it would be refused next time
      assert.deepEqual(result.native, native([said]));
    });
  }

  test('keeps no record of a reply with nothing left in it', () => {
    const result = toReply(
      reply([toolUse('toolu_1')], { stop_reason: 'refusal' })
    );

    assert.equal(result.native, undefined);
    assert.equal(result.content, '');
  });
});

describe('stream', () => {
  const request = {
    model: 'claude-opus-5',
    messages: [
      { role: 'system', content: 'be brief' },
      { role: 'user', content: 'hi' }
    ],
    tools: [{ type: 'function', function: { name: 'read' } }],
    think: true
  };

  test('sends the whole conversation, the tools and the thinking setting', async () => {
    const { client, provider } = fakeClient();

    client.messages.stream.mock.mockImplementation(() =>
      fakeStream([], reply([]))
    );
    await collect(await provider.stream(request));

    assert.deepEqual(client.messages.stream.mock.calls[0].arguments[0], {
      model: 'claude-opus-5',
      system: 'be brief',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ name: 'read', input_schema: { type: 'object' } }],
      thinking: { type: 'adaptive' },
      max_tokens: 64000
    });
  });

  test('streams text and thinking, then ends with the calls and the count', async () => {
    const { client, provider } = fakeClient();
    const content = [
      { type: 'thinking', thinking: 'hmm', signature: 'sig' },
      { type: 'text', text: 'Let me look.' },
      toolUse('toolu_1')
    ];

    client.messages.stream.mock.mockImplementation(() =>
      fakeStream(
        [
          { type: 'message_start' },
          thinkingDelta('hmm'),
          textDelta('Let me '),
          textDelta('look.'),
          { type: 'message_stop' }
        ],
        reply(content, { stop_reason: 'tool_use' })
      )
    );

    const chunks = await collect(await provider.stream(request));

    assert.deepEqual(chunks, [
      { message: { role: 'assistant', content: '', thinking: 'hmm' } },
      { message: { role: 'assistant', content: 'Let me ' } },
      { message: { role: 'assistant', content: 'look.' } },
      {
        // the text was streamed already, so it is not sent again
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'toolu_1',
              function: { name: 'read', arguments: { path: 'a.ts' } }
            }
          ],
          native: native(content)
        },
        done: true,
        // cached input is still input the window had to hold
        usage: { promptTokens: 420, outputTokens: 40 }
      }
    ]);
  });

  test('is cut off by abort()', async () => {
    const { client, provider } = fakeClient();
    const stream = fakeStream([textDelta('hi')], reply([]));

    client.messages.stream.mock.mockImplementation(() => stream);

    const chunks = await provider.stream(request);

    assert.deepEqual(controllersOf(provider), [stream.controller]);

    provider.abort();

    assert.equal(stream.controller.signal.aborted, true);
    assert.deepEqual(controllersOf(provider), []);

    await collect(chunks);
  });

  test('forgets the request once it ends', async () => {
    const { client, provider } = fakeClient();
    const stream = fakeStream([textDelta('hi')], reply([]));

    client.messages.stream.mock.mockImplementation(() => stream);

    const chunks = await provider.stream(request);

    assert.deepEqual(controllersOf(provider), [stream.controller]);

    await collect(chunks);

    assert.deepEqual(controllersOf(provider), []);
    assert.equal(stream.controller.signal.aborted, false);
  });

  test('closes its own request when it is aborted', async () => {
    const { client, provider } = fakeClient();
    const stream = fakeStream([], reply([]));

    client.messages.stream.mock.mockImplementation(() => stream);
    (await provider.stream(request)).abort();

    assert.equal(stream.abort.mock.callCount(), 1);
    assert.deepEqual(controllersOf(provider), []);
  });

  test('forgets a request that fails part way through', async () => {
    const { client, provider } = fakeClient();
    const controller = new AbortController();

    client.messages.stream.mock.mockImplementation(() => ({
      controller,
      abort: () => {},
      async *[Symbol.asyncIterator]() {
        yield textDelta('hi');
        throw new Error('connection reset');
      }
    }));

    await assert.rejects(
      collect(await provider.stream(request)),
      /connection reset/
    );
    assert.deepEqual(controllersOf(provider), []);
  });
});

describe('complete', () => {
  const request = {
    model: 'claude-opus-5',
    messages: [{ role: 'user', content: 'summarize' }]
  };

  test('asks once, with a smaller cap, and returns the reply', async () => {
    const { client, provider } = fakeClient();

    client.messages.create.mock.mockImplementation(async () =>
      reply([{ type: 'text', text: 'notes' }])
    );

    const result: ChatMessage = await provider.complete(request);

    assert.equal(result.content, 'notes');
    assert.deepEqual(client.messages.create.mock.calls[0].arguments[0], {
      model: 'claude-opus-5',
      messages: [{ role: 'user', content: 'summarize' }],
      max_tokens: 16000
    });
    assert.deepEqual(controllersOf(provider), []);
  });

  test('is cut off by abort() while it waits', async () => {
    const { client, provider } = fakeClient();

    client.messages.create.mock.mockImplementation(
      (_params: unknown, options?: unknown) =>
        new Promise((_resolve, reject) => {
          const { signal } = options as { signal: AbortSignal };

          signal.addEventListener('abort', () =>
            reject(new Error('Request was aborted.'))
          );
        })
    );

    const pending = provider.complete(request);

    provider.abort();

    await assert.rejects(pending, /aborted/);
    assert.deepEqual(controllersOf(provider), []);
  });
});

describe('countTokens', () => {
  test('counts the request as it would be sent', async () => {
    const { client, provider } = fakeClient();

    client.messages.countTokens.mock.mockImplementation(async () => ({
      input_tokens: 1234
    }));

    const counted = await provider.countTokens({
      model: 'claude-opus-5',
      messages: [
        { role: 'system', content: 'be brief' },
        { role: 'user', content: 'hello' }
      ]
    });

    assert.equal(counted, 1234);
    assert.deepEqual(client.messages.countTokens.mock.calls[0].arguments[0], {
      model: 'claude-opus-5',
      system: 'be brief',
      messages: [{ role: 'user', content: 'hello' }]
    });
    assert.deepEqual(controllersOf(provider), []);
  });

  test('stands a placeholder in for an empty conversation', async () => {
    const { client, provider } = fakeClient();

    client.messages.countTokens.mock.mockImplementation(async () => ({
      input_tokens: 900
    }));

    await provider.countTokens({
      model: 'claude-opus-5',
      messages: [{ role: 'system', content: 'be brief' }]
    });

    assert.deepEqual(
      (
        client.messages.countTokens.mock.calls[0].arguments[0] as {
          messages: unknown[];
        }
      ).messages,
      [{ role: 'user', content: '.' }]
    );
  });

  test('is cut off by abort() while it waits', async () => {
    const { client, provider } = fakeClient();

    client.messages.countTokens.mock.mockImplementation(
      (_params: unknown, options?: unknown) =>
        new Promise((_resolve, reject) => {
          const { signal } = options as { signal: AbortSignal };

          signal.addEventListener('abort', () =>
            reject(new Error('Request was aborted.'))
          );
        })
    );

    const pending = provider.countTokens({
      model: 'claude-opus-5',
      messages: []
    });

    provider.abort();

    await assert.rejects(pending, /aborted/);
    assert.deepEqual(controllersOf(provider), []);
  });
});

describe('describeModel', () => {
  const capabilities = (adaptive: boolean, images: boolean) => ({
    thinking: { supported: true, types: { adaptive: { supported: adaptive } } },
    image_input: { supported: images }
  });

  test('reports what the model can do and how much it can read', async () => {
    const { client, provider } = fakeClient();

    client.models.retrieve.mock.mockImplementation(async () => ({
      id: 'claude-opus-5',
      max_input_tokens: 1_000_000,
      max_tokens: 128_000,
      capabilities: capabilities(true, true)
    }));

    assert.deepEqual(await provider.describeModel('claude-opus-5'), {
      capabilities: ['tools', 'thinking', 'vision'],
      contextLength: 1_000_000
    });
    assert.deepEqual(client.models.retrieve.mock.calls[0].arguments, [
      'claude-opus-5'
    ]);
  });

  test('does not claim thinking a model can only do on a token budget', async () => {
    const { client, provider } = fakeClient();

    client.models.retrieve.mock.mockImplementation(async () => ({
      id: 'claude-haiku-4-5',
      max_input_tokens: 200_000,
      max_tokens: 64_000,
      capabilities: capabilities(false, true)
    }));

    const { capabilities: reported } =
      await provider.describeModel('claude-haiku-4-5');

    assert.deepEqual(reported, ['tools', 'vision']);
  });

  test('says nothing it was not told', async () => {
    const { client, provider } = fakeClient();

    client.models.retrieve.mock.mockImplementation(async () => ({
      id: 'claude-opus-5',
      max_input_tokens: null,
      max_tokens: null,
      capabilities: null
    }));

    assert.deepEqual(await provider.describeModel('claude-opus-5'), {
      capabilities: ['tools'],
      contextLength: undefined
    });
  });
});

describe('listModels', () => {
  test('reads every page, by id', async () => {
    const { client, provider } = fakeClient();

    // the SDK's page fetches the next one as it is iterated
    client.models.list.mock.mockImplementation(() =>
      (async function* () {
        yield { id: 'claude-opus-5', display_name: 'Claude Opus 5' };
        yield { id: 'claude-sonnet-5', display_name: 'Claude Sonnet 5' };
      })()
    );

    assert.deepEqual(await provider.listModels(), [
      { name: 'claude-opus-5', id: 'claude-opus-5' },
      { name: 'claude-sonnet-5', id: 'claude-sonnet-5' }
    ]);
  });
});
