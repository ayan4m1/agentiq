import { test, describe, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type OpenAI from 'openai';

import { openai } from '../modules/config';
import {
  OpenAIProvider,
  makeClient,
  readContextLength,
  toMessages,
  toReasoning,
  toReply,
  toTool,
  toUsage
} from './openai';
import type { ChatChunk, ChatMessage } from '../types';

type CreateOptions = { signal: AbortSignal };

// a server that answers with whatever the test hands it
const fakeClient = () => {
  const client = {
    chat: {
      completions: {
        create: mock.fn<(params: unknown, options: CreateOptions) => unknown>()
      }
    },
    models: {
      list: mock.fn<() => unknown>()
    }
  };

  return {
    client,
    provider: new OpenAIProvider(client as unknown as OpenAI)
  };
};

const paramsOf = (client: ReturnType<typeof fakeClient>['client']) =>
  client.chat.completions.create.mock.calls[0].arguments[0] as Record<
    string,
    unknown
  >;

const optionsOf = (client: ReturnType<typeof fakeClient>['client']) =>
  client.chat.completions.create.mock.calls[0].arguments[1];

const controllersOf = (provider: OpenAIProvider) =>
  (provider as unknown as { controllers: AbortController[] }).controllers;

// what the SDK's paginated list hands back - something to iterate
const pages = (models: unknown[]) => ({
  async *[Symbol.asyncIterator]() {
    yield* models;
  }
});

// a streamed chunk with one choice holding the given delta
const chunk = (
  delta: Record<string, unknown>,
  extra: Record<string, unknown> = {}
) => ({
  id: 'chatcmpl-1',
  object: 'chat.completion.chunk',
  choices: [{ index: 0, delta, finish_reason: null }],
  ...extra
});

const finished = (reason: string) => ({
  choices: [{ index: 0, delta: {}, finish_reason: reason }]
});

// the chunk include_usage asks for, which has no choices at all
const usageChunk = (usage: Record<string, unknown>) => ({
  choices: [],
  usage
});

const callPiece = (
  index: number,
  piece: { id?: string; name?: string; arguments?: string }
) =>
  chunk({
    tool_calls: [
      {
        index,
        ...(piece.id ? { id: piece.id, type: 'function' } : {}),
        function: {
          ...(piece.name ? { name: piece.name } : {}),
          ...(piece.arguments !== undefined
            ? { arguments: piece.arguments }
            : {})
        }
      }
    ]
  });

const streamOf = (chunks: unknown[]) => ({
  async *[Symbol.asyncIterator]() {
    yield* chunks;
  }
});

const collect = async (chunks: AsyncIterable<ChatChunk>) => {
  const all: ChatChunk[] = [];

  for await (const piece of chunks) {
    all.push(piece);
  }

  return all;
};

const completion = (
  message: Record<string, unknown>,
  finishReason = 'stop'
) => ({
  id: 'chatcmpl-1',
  object: 'chat.completion',
  choices: [
    {
      index: 0,
      message: { role: 'assistant', content: null, ...message },
      finish_reason: finishReason
    }
  ]
});

const request = {
  model: 'qwen3',
  messages: [{ role: 'user', content: 'hi' }]
};

const saved = { ...openai };
const savedEnvKey = process.env.OPENAI_API_KEY;

afterEach(() => {
  Object.assign(openai, saved);

  if (savedEnvKey === undefined) {
    delete process.env.OPENAI_API_KEY;
  } else {
    process.env.OPENAI_API_KEY = savedEnvKey;
  }
});

describe('makeClient', () => {
  test('requires a key when no base URL is set', () => {
    openai.apiKey = '';
    openai.baseUrl = '';
    delete process.env.OPENAI_API_KEY;

    assert.throws(makeClient, /openai\.apiKey \(AQ_OPENAI_API_KEY\)/);
  });

  test('uses a configured key over the environment', () => {
    openai.apiKey = 'sk-config';
    process.env.OPENAI_API_KEY = 'sk-env';

    assert.equal(makeClient().apiKey, 'sk-config');
  });

  test('falls back to OPENAI_API_KEY', () => {
    openai.apiKey = '';
    openai.baseUrl = '';
    process.env.OPENAI_API_KEY = 'sk-env';

    assert.equal(makeClient().apiKey, 'sk-env');
  });

  test('needs no key for a server the user pointed at', () => {
    openai.apiKey = '';
    openai.baseUrl = 'http://localhost:8080/v1';
    delete process.env.OPENAI_API_KEY;

    const client = makeClient();

    assert.equal(client.baseURL, 'http://localhost:8080/v1');
    assert.ok(client.apiKey);
  });

  test('talks to the OpenAI API when no base URL is set', () => {
    openai.apiKey = 'sk-config';
    openai.baseUrl = '';

    assert.equal(
      makeClient().baseURL,
      process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1'
    );
  });
});

describe('OpenAIProvider', () => {
  test('builds its client on first use, not when it is made', async () => {
    openai.apiKey = '';
    openai.baseUrl = '';
    delete process.env.OPENAI_API_KEY;

    // making it must not throw - this happens as the module loads
    const provider = new OpenAIProvider();

    await assert.rejects(provider.listModels(), /OPENAI_API_KEY/);
  });

  test('keeps the client it built', () => {
    openai.apiKey = 'sk-config';

    const provider = new OpenAIProvider();

    assert.equal(provider.client, provider.client);
  });

  test('names the OpenAI API when no base URL is set', () => {
    openai.baseUrl = '';

    assert.equal(fakeClient().provider.label, 'OpenAI API');
  });

  test('names the server it was pointed at', () => {
    openai.baseUrl = 'http://localhost:8000/v1';

    assert.equal(
      fakeClient().provider.label,
      'OpenAI-compatible server at http://localhost:8000/v1'
    );
  });
});

describe('toMessages', () => {
  test('passes system, user and assistant text through', () => {
    assert.deepEqual(
      toMessages([
        { role: 'system', content: 'be brief' },
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' }
      ]),
      [
        { role: 'system', content: 'be brief' },
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' }
      ]
    );
  });

  test('sends calls with their ids and results paired to them', () => {
    const messages: ChatMessage[] = [
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'call_1', function: { name: 'read', arguments: { path: 'a' } } }
        ]
      },
      {
        role: 'tool',
        content: 'file a',
        tool_name: 'read',
        tool_call_id: 'call_1'
      }
    ];

    assert.deepEqual(toMessages(messages), [
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'read', arguments: '{"path":"a"}' }
          }
        ]
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'file a' }
    ]);
  });

  test('leaves out a call with no id and sends its result as text', () => {
    // ollama gives its calls no ids, and a turn it wrote may be resumed here
    const messages: ChatMessage[] = [
      {
        role: 'assistant',
        content: 'reading',
        tool_calls: [{ function: { name: 'read', arguments: {} } }]
      },
      { role: 'tool', content: 'file a', tool_name: 'read' }
    ];

    assert.deepEqual(toMessages(messages), [
      { role: 'assistant', content: 'reading' },
      { role: 'user', content: 'Result of read:\nfile a' }
    ]);
  });

  test('holds unpaired results back until the paired ones are sent', () => {
    const messages: ChatMessage[] = [
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'call_1', function: { name: 'read', arguments: {} } }
        ]
      },
      { role: 'tool', content: 'stray', tool_call_id: 'call_9' },
      { role: 'tool', content: 'other' },
      { role: 'tool', content: 'file a', tool_call_id: 'call_1' },
      { role: 'user', content: 'next' }
    ];

    assert.deepEqual(toMessages(messages).slice(1), [
      { role: 'tool', tool_call_id: 'call_1', content: 'file a' },
      {
        role: 'user',
        content: 'Result of a tool:\nstray\n\nResult of a tool:\nother'
      },
      { role: 'user', content: 'next' }
    ]);
  });

  test('drops an assistant turn with nothing in it', () => {
    assert.deepEqual(
      toMessages([
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: '' }
      ]),
      [{ role: 'user', content: 'hi' }]
    );
  });

  test('only pairs results with the turn just before them', () => {
    const call = { id: 'call_1', function: { name: 'read', arguments: {} } };
    const converted = toMessages([
      { role: 'assistant', content: '', tool_calls: [call] },
      { role: 'tool', content: 'first', tool_call_id: 'call_1' },
      { role: 'assistant', content: 'done' },
      { role: 'tool', content: 'late', tool_call_id: 'call_1' }
    ]);

    assert.deepEqual(converted.at(-1), {
      role: 'user',
      content: 'Result of a tool:\nlate'
    });
  });
});

describe('toTool', () => {
  test('wraps the definition as a function tool', () => {
    assert.deepEqual(
      toTool({
        type: 'function',
        function: {
          name: 'read',
          description: 'reads a file',
          parameters: { required: ['path'], properties: { path: {} } }
        }
      }),
      {
        type: 'function',
        function: {
          name: 'read',
          description: 'reads a file',
          parameters: {
            type: 'object',
            required: ['path'],
            properties: { path: {} }
          }
        }
      }
    );
  });

  test('leaves out a missing description and name', () => {
    assert.deepEqual(toTool({ type: 'function', function: {} }), {
      type: 'function',
      function: { name: '', parameters: { type: 'object' } }
    });
  });
});

describe('toReasoning', () => {
  test('sends nothing when unset', () => {
    assert.deepEqual(toReasoning(undefined), {});
  });

  test('sends a level as reasoning_effort', () => {
    for (const level of ['low', 'medium', 'high'] as const) {
      assert.deepEqual(toReasoning(level), { reasoning_effort: level });
    }
  });

  test('sends on or off through the chat template to a chosen server', () => {
    openai.baseUrl = 'http://localhost:8000/v1';

    assert.deepEqual(toReasoning(true), {
      chat_template_kwargs: { enable_thinking: true }
    });
    assert.deepEqual(toReasoning(false), {
      chat_template_kwargs: { enable_thinking: false }
    });
  });

  test('sends no on or off to the OpenAI API, which would refuse it', () => {
    openai.baseUrl = '';

    assert.deepEqual(toReasoning(true), {});
    assert.deepEqual(toReasoning(false), {});
  });
});

describe('toReply', () => {
  const call = (args: string, id = 'call_1') => ({
    id,
    name: 'read',
    arguments: args
  });

  test('parses each call', () => {
    assert.deepEqual(toReply('ok', '', [call('{"path":"a"}')], 'tool_calls'), {
      role: 'assistant',
      content: 'ok',
      tool_calls: [
        { id: 'call_1', function: { name: 'read', arguments: { path: 'a' } } }
      ]
    });
  });

  test('keeps the reasoning', () => {
    assert.deepEqual(toReply('ok', 'hmm', [], 'stop'), {
      role: 'assistant',
      content: 'ok',
      thinking: 'hmm'
    });
  });

  test('reads empty arguments as a call that takes nothing', () => {
    assert.deepEqual(toReply('', '', [call('')])?.tool_calls, [
      { id: 'call_1', function: { name: 'read', arguments: {} } }
    ]);
  });

  test('drops only the calls whose arguments do not parse', () => {
    const reply = toReply('', '', [
      call('{"path":', 'call_1'),
      call('[1]', 'call_2'),
      call('{}', 'call_3')
    ]);

    assert.deepEqual(
      reply.tool_calls?.map((parsed) => parsed.id),
      ['call_3']
    );
  });

  test('drops every call from a reply that ran out of tokens', () => {
    assert.deepEqual(toReply('so', '', [call('{"path":"a"}')], 'length'), {
      role: 'assistant',
      content: 'so'
    });
  });

  test('keeps a truncated reply that made no calls', () => {
    assert.deepEqual(toReply('so', '', [], 'length'), {
      role: 'assistant',
      content: 'so'
    });
  });

  test('leaves the id off a call the server gave none', () => {
    assert.equal(
      toReply('', '', [call('{}', '')]).tool_calls?.[0].id,
      undefined
    );
  });
});

describe('toUsage', () => {
  test('reports the counts and what was cached', () => {
    assert.deepEqual(
      toUsage({
        prompt_tokens: 100,
        completion_tokens: 20,
        total_tokens: 120,
        prompt_tokens_details: { cached_tokens: 80 }
      }),
      { promptTokens: 100, outputTokens: 20, cache: { readTokens: 80 } }
    );
  });

  test('says nothing about a cache the server did not report', () => {
    assert.deepEqual(
      toUsage({ prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }),
      { promptTokens: 100, outputTokens: 20 }
    );
  });
});

describe('readContextLength', () => {
  test('reads vLLM max_model_len', () => {
    assert.equal(readContextLength({ id: 'm', max_model_len: 32768 }), 32768);
  });

  test('reads llama.cpp n_ctx_train', () => {
    assert.equal(
      readContextLength({ id: 'm', meta: { n_ctx_train: 131072 } }),
      131072
    );
  });

  test('is undefined when the server does not say', () => {
    assert.equal(readContextLength({ id: 'm' }), undefined);
    assert.equal(readContextLength({ id: 'm', meta: {} }), undefined);
  });
});

describe('stream', () => {
  test('asks for usage and sends the request it was given', async () => {
    const { client, provider } = fakeClient();

    client.chat.completions.create.mock.mockImplementation(async () =>
      streamOf([])
    );
    await collect(
      await provider.stream({
        ...request,
        think: 'high',
        tools: [{ type: 'function', function: { name: 'read' } }]
      })
    );

    assert.deepEqual(paramsOf(client), {
      model: 'qwen3',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [
        {
          type: 'function',
          function: { name: 'read', parameters: { type: 'object' } }
        }
      ],
      reasoning_effort: 'high',
      stream: true,
      stream_options: { include_usage: true }
    });
    assert.ok(optionsOf(client).signal instanceof AbortSignal);
  });

  test('yields text and reasoning as they arrive', async () => {
    const { client, provider } = fakeClient();

    client.chat.completions.create.mock.mockImplementation(async () =>
      streamOf([
        chunk({ reasoning_content: 'let me ' }),
        chunk({ reasoning: 'think' }),
        chunk({ content: 'Hel' }),
        chunk({ content: 'lo' }),
        finished('stop'),
        usageChunk({
          prompt_tokens: 10,
          completion_tokens: 4,
          total_tokens: 14
        })
      ])
    );

    const chunks = await collect(await provider.stream(request));

    assert.deepEqual(
      chunks.map((piece) => piece.message),
      [
        { role: 'assistant', content: '', thinking: 'let me ' },
        { role: 'assistant', content: '', thinking: 'think' },
        { role: 'assistant', content: 'Hel' },
        { role: 'assistant', content: 'lo' },
        { role: 'assistant', content: '' }
      ]
    );
    assert.equal(chunks.at(-1)?.done, true);
    assert.deepEqual(chunks.at(-1)?.usage, {
      promptTokens: 10,
      outputTokens: 4
    });
  });

  test('puts calls back together from the pieces they arrive in', async () => {
    const { client, provider } = fakeClient();

    client.chat.completions.create.mock.mockImplementation(async () =>
      streamOf([
        callPiece(0, { id: 'call_1', name: 'read', arguments: '' }),
        callPiece(1, { id: 'call_2', name: 'list', arguments: '{"pa' }),
        callPiece(0, { arguments: '{"path":' }),
        callPiece(1, { arguments: 'th":"."}' }),
        callPiece(0, { arguments: '"a.ts"}' }),
        finished('tool_calls'),
        usageChunk({
          prompt_tokens: 10,
          completion_tokens: 4,
          total_tokens: 14,
          prompt_tokens_details: { cached_tokens: 6 }
        })
      ])
    );

    const last = (await collect(await provider.stream(request))).at(-1);

    assert.deepEqual(last, {
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_1',
            function: { name: 'read', arguments: { path: 'a.ts' } }
          },
          { id: 'call_2', function: { name: 'list', arguments: { path: '.' } } }
        ]
      },
      done: true,
      usage: { promptTokens: 10, outputTokens: 4, cache: { readTokens: 6 } }
    });
  });

  test('copes with a piece of a call that carries no function', async () => {
    const { client, provider } = fakeClient();

    client.chat.completions.create.mock.mockImplementation(async () =>
      streamOf([
        chunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function' }] }),
        callPiece(0, { name: 'read', arguments: '{}' })
      ])
    );

    const last = (await collect(await provider.stream(request))).at(-1);

    assert.deepEqual(last?.message.tool_calls, [
      { id: 'call_1', function: { name: 'read', arguments: {} } }
    ]);
  });

  test('runs no calls from a reply that ran out of tokens', async () => {
    const { client, provider } = fakeClient();

    client.chat.completions.create.mock.mockImplementation(async () =>
      streamOf([
        callPiece(0, { id: 'call_1', name: 'read', arguments: '{"path":"a"}' }),
        finished('length')
      ])
    );

    const last = (await collect(await provider.stream(request))).at(-1);

    assert.deepEqual(last, {
      message: { role: 'assistant', content: '' },
      done: true
    });
  });

  test('leaves the usage off when the server sent none', async () => {
    const { client, provider } = fakeClient();

    client.chat.completions.create.mock.mockImplementation(async () =>
      streamOf([chunk({ content: 'hi' }), finished('stop')])
    );

    const last = (await collect(await provider.stream(request))).at(-1);

    assert.equal(last?.usage, undefined);
  });

  test('lets go of its request once the reply is done', async () => {
    const { client, provider } = fakeClient();

    client.chat.completions.create.mock.mockImplementation(async () =>
      streamOf([chunk({ content: 'hi' })])
    );

    const stream = await provider.stream(request);

    assert.equal(controllersOf(provider).length, 1);

    await collect(stream);

    assert.deepEqual(controllersOf(provider), []);
    assert.equal(optionsOf(client).signal.aborted, false);
  });

  test('closes its own request when it is aborted', async () => {
    const { client, provider } = fakeClient();

    client.chat.completions.create.mock.mockImplementation(async () =>
      streamOf([])
    );
    (await provider.stream(request)).abort();

    assert.equal(optionsOf(client).signal.aborted, true);
    assert.deepEqual(controllersOf(provider), []);
  });

  test('is cut off by abort()', async () => {
    const { client, provider } = fakeClient();

    client.chat.completions.create.mock.mockImplementation(async () =>
      streamOf([])
    );
    await provider.stream(request);
    provider.abort();

    assert.equal(optionsOf(client).signal.aborted, true);
    assert.deepEqual(controllersOf(provider), []);
  });

  test('lets go of a request the server refused', async () => {
    const { client, provider } = fakeClient();

    client.chat.completions.create.mock.mockImplementation(async () => {
      throw new Error('400 bad request');
    });

    await assert.rejects(provider.stream(request), /400 bad request/);
    assert.deepEqual(controllersOf(provider), []);
  });
});

describe('complete', () => {
  test('returns the whole reply', async () => {
    const { client, provider } = fakeClient();

    client.chat.completions.create.mock.mockImplementation(async () =>
      completion({ content: 'hello', reasoning_content: 'hmm' })
    );

    assert.deepEqual(await provider.complete(request), {
      role: 'assistant',
      content: 'hello',
      thinking: 'hmm'
    });
    assert.equal(paramsOf(client).stream, false);
    assert.ok(optionsOf(client).signal instanceof AbortSignal);
    assert.deepEqual(controllersOf(provider), []);
  });

  test('returns its function calls and nothing else', async () => {
    const { client, provider } = fakeClient();

    client.chat.completions.create.mock.mockImplementation(async () =>
      completion(
        {
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'read', arguments: '{"path":"a"}' }
            },
            { id: 'call_2', type: 'custom', custom: { name: 'x', input: '' } }
          ]
        },
        'tool_calls'
      )
    );

    assert.deepEqual(await provider.complete(request), {
      role: 'assistant',
      content: '',
      tool_calls: [
        { id: 'call_1', function: { name: 'read', arguments: { path: 'a' } } }
      ]
    });
  });

  test('drops the calls from a reply that ran out of tokens', async () => {
    const { client, provider } = fakeClient();

    client.chat.completions.create.mock.mockImplementation(async () =>
      completion(
        {
          content: 'so',
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'read', arguments: '{"pa' }
            }
          ]
        },
        'length'
      )
    );

    assert.deepEqual(await provider.complete(request), {
      role: 'assistant',
      content: 'so'
    });
  });

  test('copes with a reply that has no choices', async () => {
    const { client, provider } = fakeClient();

    client.chat.completions.create.mock.mockImplementation(async () => ({
      choices: []
    }));

    assert.deepEqual(await provider.complete(request), {
      role: 'assistant',
      content: ''
    });
  });

  test('is cut off by abort() while it waits', async () => {
    const { client, provider } = fakeClient();

    client.chat.completions.create.mock.mockImplementation(
      (_params, { signal }) =>
        new Promise((_resolve, reject) => {
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

describe('listModels', () => {
  test('names each model by its id', async () => {
    const { client, provider } = fakeClient();

    client.models.list.mock.mockImplementation(() =>
      pages([{ id: 'qwen3' }, { id: 'gemma4' }])
    );

    assert.deepEqual(await provider.listModels(), [
      { name: 'qwen3', id: 'qwen3' },
      { name: 'gemma4', id: 'gemma4' }
    ]);
  });
});

describe('describeModel', () => {
  test('reads the context length from the model list', async () => {
    const { client, provider } = fakeClient();

    client.models.list.mock.mockImplementation(() =>
      pages([{ id: 'other' }, { id: 'qwen3', max_model_len: 40960 }])
    );

    assert.deepEqual(await provider.describeModel('qwen3'), {
      capabilities: [],
      contextLength: 40960
    });
  });

  test('says nothing about a model the server does not list', async () => {
    const { client, provider } = fakeClient();

    client.models.list.mock.mockImplementation(() => pages([{ id: 'other' }]));

    assert.deepEqual(await provider.describeModel('qwen3'), {
      capabilities: []
    });
  });
});
