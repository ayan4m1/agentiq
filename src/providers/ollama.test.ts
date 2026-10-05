import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { ChatResponse, Ollama, ShowResponse } from 'ollama';

import { ollama, provider as providerConfig } from '../modules/config';
import { OllamaProvider, readContextLength } from './ollama';
import type { ChatChunk, ChatRequest } from '../types';

// the client is read from config as the provider is built, so each case sets
// the config first and then builds one of its own. what the client was built
// with is not part of its public face, so it is read past the type
const configOf = (client: Ollama) =>
  (client as unknown as { config: { host: string; headers?: unknown } }).config;

describe('the client it builds', () => {
  test('talks to the configured host', () => {
    ollama.host = 'http://ollama.test:4321';
    ollama.bearerToken = undefined;

    const config = configOf(new OllamaProvider().client);

    assert.equal(config.host, 'http://ollama.test:4321');
  });

  test('sends a bearer token when one is configured', () => {
    ollama.host = 'http://ollama.test:4321';
    ollama.bearerToken = 'secret';

    const config = configOf(new OllamaProvider().client);

    assert.deepEqual(config.headers, {
      Authorization: 'Bearer secret'
    });
  });

  test('sends no authorization header without a token', () => {
    ollama.host = 'http://ollama.test:4321';
    ollama.bearerToken = undefined;

    const config = configOf(new OllamaProvider().client);

    assert.equal(config.headers, undefined);
  });
});

describe('label', () => {
  test('names the configured host', () => {
    ollama.host = 'http://127.0.0.1:1';

    assert.equal(new OllamaProvider().label, 'ollama at http://127.0.0.1:1');
  });

  test('falls back to the default address without one', () => {
    ollama.host = undefined;

    assert.equal(new OllamaProvider().label, 'ollama at its default address');
  });
});

// a server that answers with whatever the test hands it
const fakeClient = (overrides: Record<string, unknown> = {}) => {
  const client = {
    chat: mock.fn<(request: unknown) => Promise<unknown>>(async () => {
      throw new Error('no response was set up for this test');
    }),
    abort: mock.fn(),
    list: mock.fn(async (): Promise<unknown> => ({ models: [] })),
    show: mock.fn<(request: unknown) => Promise<unknown>>(async () => ({})),
    systemone: mock.fn<(request: unknown) => Promise<unknown>>(async () => ({
      answers: {}
    })),
    ...overrides
  };

  return {
    client,
    provider: new OllamaProvider(client as unknown as Ollama)
  };
};

const request: ChatRequest = {
  model: 'test-model',
  messages: [{ role: 'user', content: 'hi' }],
  think: true
};

const response = (extra: Partial<ChatResponse> = {}) =>
  ({
    message: { role: 'assistant', content: '' },
    done: false,
    ...extra
  }) as ChatResponse;

describe('stream', () => {
  // what ollama.chat hands back when asked to stream
  const responding = (...responses: ChatResponse[]) => {
    const abort = mock.fn();

    return {
      abort,
      iterator: {
        abort,
        async *[Symbol.asyncIterator]() {
          yield* responses;
        }
      }
    };
  };

  const collect = async (chunks: AsyncIterable<ChatChunk>) => {
    const all: ChatChunk[] = [];

    for await (const chunk of chunks) {
      all.push(chunk);
    }

    return all;
  };

  test('asks for a stream sized to the configured context', async () => {
    const { iterator } = responding();
    const { client, provider } = fakeClient({
      chat: mock.fn(async () => iterator)
    });

    await provider.stream(request);

    assert.deepEqual(client.chat.mock.calls[0].arguments[0], {
      ...request,
      stream: true,
      keep_alive: ollama.keepAlive,
      options: { num_ctx: providerConfig.contextLimit }
    });
  });

  test('passes each message through and reports usage at the end', async () => {
    const { iterator } = responding(
      response({ message: { role: 'assistant', content: 'hel' } }),
      response({ message: { role: 'assistant', content: 'lo' } }),
      response({
        done: true,
        prompt_eval_count: 1000,
        eval_count: 20,
        eval_duration: 1e9
      })
    );
    const { provider } = fakeClient({ chat: mock.fn(async () => iterator) });

    const chunks = await collect(await provider.stream(request));

    assert.deepEqual(chunks, [
      { message: { role: 'assistant', content: 'hel' }, done: false },
      { message: { role: 'assistant', content: 'lo' }, done: false },
      {
        message: { role: 'assistant', content: '' },
        done: true,
        usage: { promptTokens: 1000, outputTokens: 20, outputDurationNs: 1e9 }
      }
    ]);
  });

  test('closes the response it was given when aborted', async () => {
    const { abort, iterator } = responding();
    const { provider } = fakeClient({ chat: mock.fn(async () => iterator) });

    (await provider.stream(request)).abort();

    assert.equal(abort.mock.callCount(), 1);
  });

  test('hands a failed request back to the caller', async () => {
    const { provider } = fakeClient();

    await assert.rejects(provider.stream(request), /no response was set up/);
  });
});

describe('complete', () => {
  test('asks once, sized to the configured context, and returns the reply', async () => {
    const reply = { role: 'assistant', content: 'an answer' };
    const { client, provider } = fakeClient({
      chat: mock.fn(async () => response({ message: reply, done: true }))
    });

    assert.deepEqual(await provider.complete(request), reply);
    assert.deepEqual(client.chat.mock.calls[0].arguments[0], {
      ...request,
      stream: false,
      keep_alive: ollama.keepAlive,
      options: { num_ctx: providerConfig.contextLimit }
    });
  });

  // images are kept in ollama's own shape, so they go out untouched
  test('passes images through as they are', async () => {
    const pictured: ChatRequest = {
      model: 'test-model',
      messages: [
        { role: 'user', content: 'what is this?', images: ['iVBORw0KGgo='] },
        {
          role: 'tool',
          tool_name: 'shot',
          content: '[image]',
          images: ['/9j/4A==']
        }
      ]
    };
    const { client, provider } = fakeClient({
      chat: mock.fn(async () =>
        response({ message: { role: 'assistant', content: 'a cat' } })
      )
    });

    await provider.complete(pictured);

    assert.deepEqual(
      (client.chat.mock.calls[0].arguments[0] as ChatRequest).messages,
      pictured.messages
    );
  });

  test('hands back images a reply carries as base64', async () => {
    const { provider } = fakeClient({
      chat: mock.fn(async () =>
        response({
          message: {
            role: 'assistant',
            content: '',
            images: [new Uint8Array([0x89, 0x50, 0x4e, 0x47])]
          }
        })
      )
    });

    assert.deepEqual((await provider.complete(request)).images, ['iVBORw==']);
  });
});

describe('abort', () => {
  test('cancels whatever the client has in flight', () => {
    const { client, provider } = fakeClient();

    provider.abort();

    assert.equal(client.abort.mock.callCount(), 1);
  });
});

describe('listModels', () => {
  test('keeps both of the names ollama gives a model', async () => {
    const { provider } = fakeClient({
      list: mock.fn(async () => ({
        models: [{ name: 'gemma3:latest', model: 'gemma3:latest' }]
      }))
    });

    assert.deepEqual(await provider.listModels(), [
      { name: 'gemma3:latest', id: 'gemma3:latest' }
    ]);
  });

  test('fills in whichever name is missing from the other', async () => {
    const { provider } = fakeClient({
      list: mock.fn(async () => ({
        models: [{ name: 'only-a-name' }, { model: 'only-a-model' }]
      }))
    });

    assert.deepEqual(await provider.listModels(), [
      { name: 'only-a-name', id: 'only-a-name' },
      { name: 'only-a-model', id: 'only-a-model' }
    ]);
  });

  test('hands an unreachable server back to the caller', async () => {
    const { provider } = fakeClient({
      list: mock.fn(async () => {
        throw new Error('ECONNREFUSED');
      })
    });

    await assert.rejects(provider.listModels(), /ECONNREFUSED/);
  });
});

describe('describeModel', () => {
  test('reports what the server says the model can do and hold', async () => {
    const { client, provider } = fakeClient({
      show: mock.fn(async () => ({
        capabilities: ['completion', 'tools'],
        model_info: {
          'general.architecture': 'gemma3',
          'gemma3.context_length': 131072
        }
      }))
    });

    assert.deepEqual(await provider.describeModel('gemma3'), {
      capabilities: ['completion', 'tools'],
      contextLength: 131072
    });
    assert.deepEqual(client.show.mock.calls[0].arguments[0], {
      model: 'gemma3'
    });
  });

  test('reports no capabilities for a server too old to say', async () => {
    const { provider } = fakeClient();

    assert.deepEqual(await provider.describeModel('gemma3'), {
      capabilities: [],
      contextLength: undefined
    });
  });
});

describe('readContextLength', () => {
  test('reads the key named for the architecture', () => {
    assert.equal(
      readContextLength({
        'general.architecture': 'gemma3',
        'gemma3.context_length': 131072,
        'llama.context_length': 4096
      } as unknown as ShowResponse['model_info']),
      131072
    );
  });

  test('reads it out of a real Map too', () => {
    const info = new Map<string, unknown>([
      ['general.architecture', 'qwen3'],
      ['qwen3.context_length', 40960]
    ]);

    assert.equal(readContextLength(info as ShowResponse['model_info']), 40960);
  });

  test('falls back to any context length when the architecture is missing', () => {
    assert.equal(
      readContextLength({
        'mystery.context_length': 8192
      } as unknown as ShowResponse['model_info']),
      8192
    );
  });

  test('returns nothing when there is no context length at all', () => {
    assert.equal(
      readContextLength({
        'general.architecture': 'gemma3'
      } as unknown as ShowResponse['model_info']),
      undefined
    );
  });

  test('ignores a context length that is not a number', () => {
    assert.equal(
      readContextLength({
        'general.architecture': 'gemma3',
        'gemma3.context_length': 'lots'
      } as unknown as ShowResponse['model_info']),
      undefined
    );
  });

  test('survives model_info being absent', () => {
    assert.equal(
      readContextLength(undefined as unknown as ShowResponse['model_info']),
      undefined
    );
  });
});

describe('decide', () => {
  test('asks each question as a noul question, keyed by position', async () => {
    ollama.keepAlive = '30m';
    const { client, provider } = fakeClient();

    await provider.decide({
      model: 'kev-9b',
      state: 'CI is red on main',
      questions: ['Is the build broken?', 'Is it flaky?']
    });

    assert.deepEqual(client.systemone.mock.calls[0].arguments, [
      {
        model: 'kev-9b',
        state: 'CI is red on main',
        questions: {
          q1: { type: 'noul', instructions: 'Is the build broken?' },
          q2: { type: 'noul', instructions: 'Is it flaky?' }
        },
        keep_alive: '30m'
      }
    ]);
  });

  test('hands the answers back in the order they were asked', async () => {
    const { provider } = fakeClient({
      systemone: mock.fn(async () => ({
        answers: {
          q2: { type: 'noul', noul: 0.25 },
          q1: { type: 'noul', noul: 0.75 }
        }
      }))
    });

    const { probabilities } = await provider.decide({
      model: 'kev-9b',
      state: 'state',
      questions: ['first', 'second']
    });

    assert.deepEqual(probabilities, [0.75, 0.25]);
  });

  test('leaves a missing or unexpected answer undefined', async () => {
    const { provider } = fakeClient({
      systemone: mock.fn(async () => ({
        answers: {
          q1: { type: 'choice', choice: 'a', probabilities: {}, confidence: 1 }
        }
      }))
    });

    const { probabilities } = await provider.decide({
      model: 'kev-9b',
      state: 'state',
      questions: ['first', 'second']
    });

    assert.deepEqual(probabilities, [undefined, undefined]);
  });

  test('copes with a response that has no answers at all', async () => {
    const { provider } = fakeClient({
      systemone: mock.fn(async () => ({}))
    });

    const { probabilities } = await provider.decide({
      model: 'kev-9b',
      state: 'state',
      questions: ['first']
    });

    assert.deepEqual(probabilities, [undefined]);
  });
});
