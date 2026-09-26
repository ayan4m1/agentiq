import { test, describe, before, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { mkdtempSync } from 'node:fs';
import type { ChatRequest, Message } from 'ollama';

import type { AgentMessage } from '../types';

// an empty state directory means no cached tokenizer, so the thinker falls
// back to estimating - which keeps this fast and keeps the numbers below
// predictable. it also has to be set before the module first evaluates
process.env.AQ_HOME = mkdtempSync(resolve(tmpdir(), 'agentiq-thinker-'));

const { ollama, session } = await import('./config');
const { makeTool, makeParameter } = await import('../utils');

// escape is watched for on a real terminal, which a test does not have - so
// the watcher hands its callback over instead, for a test to press escape with
let pressEscape: (() => void) | undefined;
const stopWatching = mock.fn();
const watchForInterrupt = mock.fn((onInterrupt: () => void) => {
  pressEscape = onInterrupt;

  return stopWatching;
});

mock.module('./interrupt', { namedExports: { watchForInterrupt } });

// the spinner draws on a real terminal, which a test does not have - so a fake
// stands in for it, recording how it was set up and when it ran
let spinning = false;
const startSpinner = mock.fn(() => {
  spinning = true;
});
const stopSpinner = mock.fn(() => {
  spinning = false;
});
const ora = mock.fn<
  (options: { discardStdin?: boolean }) => {
    start: () => void;
    stop: () => void;
    isSpinning: boolean;
  }
>(() => ({
  start: startSpinner,
  stop: stopSpinner,
  get isSpinning() {
    return spinning;
  }
}));

mock.module('ora', { defaultExport: ora });

// what the server says the model can do is learned by preflight, which needs
// the server - so the answer is whatever the test says it is
let modelThinks = false;

mock.module('./preflight', {
  namedExports: { supportsThinking: () => modelThinks }
});

// the real prompt reads the working tree and the rules files. all that matters
// here is that it names the model, and that it can be switched off entirely
let promptBlank = false;
// the real skills block is read from ~/.agentiq/skills. the prompt below embeds
// it the way the real one does, so the thinker has something to carve out
let skillsBlock: string | undefined;

mock.module('./skills', {
  namedExports: { describeSkills: () => skillsBlock }
});

mock.module('./prompt', {
  namedExports: {
    buildSystemPrompt: () =>
      promptBlank
        ? ''
        : [`You are running as ${ollama.model}.`, skillsBlock]
            .filter(Boolean)
            .join('\n\n')
  }
});

// stand-ins with predictable behavior, one for each way a tool call can end
const echo = {
  definition: makeTool('echo', 'Repeats what it was given', [
    makeParameter('string', 'text', 'What to repeat')
  ]),
  handler: mock.fn(async ({ text }: { text: string }) => ({ echoed: text }))
};
const boom = {
  definition: makeTool('boom', 'Always fails'),
  handler: mock.fn(async () => {
    throw new Error('kaboom');
  })
};
const silent = {
  definition: makeTool('silent', 'Returns nothing'),
  handler: mock.fn(async () => undefined)
};

mock.module('../tools', { namedExports: { tools: [echo, boom, silent] } });

const { makeThinker, replayable } = await import('./ollama');
const { client } = await import('./client');
const { isElided } = await import('./compaction');
const { estimateTokens } = await import('./tokenizer');

// the server, as far as the thinker can tell. each test says what it answers
const chat = mock.method(
  client as unknown as { chat: (request: ChatRequest) => Promise<unknown> },
  'chat',
  async (): Promise<unknown> => {
    throw new Error('no response was set up for this test');
  }
);
const abortClient = mock.method(client, 'abort', () => {});
const requests = () =>
  chat.mock.calls.map((call) => call.arguments[0] as ChatRequest);

type Chunk = {
  message?: Partial<Message>;
  prompt_eval_count?: number;
  eval_count?: number;
  eval_duration?: number;
  done?: boolean;
};

const chunk = (message: Partial<Message>, extra: Omit<Chunk, 'message'> = {}) =>
  ({
    message: { role: 'assistant', content: '', ...message },
    ...extra
  }) as Chunk;

async function* streamOf(chunks: Chunk[]) {
  yield* chunks;
}

// the next chat call streams these chunks back
const respond = (...chunks: Chunk[]) =>
  chat.mock.mockImplementationOnce(async () => streamOf(chunks));

// enough tool output to put the conversation well past the point where
// compaction has to do something about it
const bulk = 'x'.repeat(50_000);

const conversation = (): Message[] => [
  { role: 'user', content: 'read the whole module and tell me what it does' },
  {
    role: 'assistant',
    content: '',
    tool_calls: [{ function: { name: 'read', arguments: { path: 'a.ts' } } }]
  },
  { role: 'tool', tool_name: 'read', content: bulk },
  {
    role: 'assistant',
    content: '',
    tool_calls: [{ function: { name: 'read', arguments: { path: 'b.ts' } } }]
  },
  { role: 'tool', tool_name: 'read', content: bulk },
  {
    role: 'assistant',
    content: '',
    tool_calls: [{ function: { name: 'read', arguments: { path: 'c.ts' } } }]
  },
  { role: 'tool', tool_name: 'read', content: bulk },
  {
    role: 'assistant',
    content: '',
    tool_calls: [{ function: { name: 'read', arguments: { path: 'd.ts' } } }]
  },
  { role: 'tool', tool_name: 'read', content: bulk },
  {
    role: 'assistant',
    content: '',
    tool_calls: [{ function: { name: 'read', arguments: { path: 'e.ts' } } }]
  },
  { role: 'tool', tool_name: 'read', content: bulk },
  {
    role: 'assistant',
    content: '',
    tool_calls: [{ function: { name: 'read', arguments: { path: 'f.ts' } } }]
  },
  { role: 'tool', tool_name: 'read', content: bulk }
];

const toolResults = (messages: Message[]) =>
  messages.filter((message) => message.role === 'tool');

describe('keeping a finished turn for the rounds that follow', () => {
  const preamble = (): Message => ({
    role: 'assistant',
    content: 'I will lay out a plan before touching anything.',
    tool_calls: [
      { function: { name: 'present_plan', arguments: { title: 'a plan' } } }
    ]
  });

  test('keeps a plain answer as it stands', () => {
    const answered: Message = {
      role: 'assistant',
      content: 'It does nothing.'
    };

    assert.equal(replayable(answered, false), answered);
  });

  test('drops the preamble of a turn that called a tool', () => {
    assert.equal(replayable(preamble(), false)?.content, '');
  });

  test('keeps the call the preamble led up to', () => {
    assert.deepEqual(
      replayable(preamble(), false)?.tool_calls,
      preamble().tool_calls
    );
  });

  test('leaves the streamed message alone, so callers still see what was said', () => {
    const message = preamble();

    replayable(message, false);

    assert.equal(message.content, preamble().content);
  });

  test('keeps the preamble when the setting asks for it', () => {
    assert.equal(replayable(preamble(), true)?.content, preamble().content);
  });

  test('drops a turn that neither spoke nor called anything either way', () => {
    // the empty answer would otherwise be persisted and sent back on every
    // request from here on, and no setting makes that worth keeping
    for (const replayPreamble of [true, false]) {
      assert.equal(
        replayable({ role: 'assistant', content: '' }, replayPreamble),
        undefined
      );
      assert.equal(
        replayable({ role: 'assistant', content: '\n\n' }, replayPreamble),
        undefined
      );
    }
  });
});

describe('compacting a conversation full of tool output', () => {
  let thinker: ReturnType<typeof makeThinker>;
  let messages: Message[];
  let freed: number;

  // the summarization tier is the one that needs a server, and eliding alone
  // gets this conversation under the target - so nothing here goes near one
  before(async () => {
    thinker = makeThinker();
    messages = conversation();
    thinker.load(messages);

    assert.ok(
      thinker.tokens.total > ollama.contextLimit * 0.5,
      'the fixture has to start above the target for any of this to mean anything'
    );

    ({ freed } = await thinker.compact(messages));
  });

  test('reclaims context without asking the model for anything', () => {
    assert.ok(freed > 0);
  });

  test('brings the total under the target it aims for', () => {
    assert.ok(thinker.tokens.total <= ollama.contextLimit * 0.5);
  });

  test('drops the oldest output first', () => {
    assert.ok(isElided(toolResults(messages)[0]));
  });

  test('stops as soon as it has enough, keeping the newest output intact', () => {
    // eliding everything would throw away what the model is working on right
    // now, which is the part it still needs
    const results = toolResults(messages);

    assert.equal(isElided(results[results.length - 1]), false);
  });

  test('says what it dropped and which call produced it', () => {
    const elided = toolResults(messages).find(isElided);

    assert.match(String(elided?.content), /50000 characters/);
    assert.match(String(elided?.content), /read\(a\.ts\)/);
  });

  test('leaves every message where it was, so calls keep their results', () => {
    assert.equal(messages.length, conversation().length);
    assert.deepEqual(
      messages.map((message) => message.role),
      conversation().map((message) => message.role)
    );
  });

  test('has nothing left to do on a second pass', async () => {
    // a second round that found more to elide would mean the first stopped
    // short; one that re-elided a marker would grow the context instead
    const again = await thinker.compact(messages);

    assert.equal(again.freed, 0);
  });
});

describe('rebuilding around a model that was just switched to', () => {
  const systemFirst = (): Message[] => [
    { role: 'system', content: 'built for the model being left behind' },
    { role: 'user', content: 'x'.repeat(400) },
    { role: 'assistant', content: 'y'.repeat(400) }
  ];

  test('names the model it was rebuilt on', () => {
    const thinker = makeThinker();
    const messages = systemFirst();

    ollama.model = 'a-completely-different-model';
    thinker.rebuild(messages);

    // think() prepends the prompt to the array the caller keeps, so the stale
    // one is already in the conversation and would go on naming the old model
    assert.equal(messages[0].role, 'system');
    assert.match(String(messages[0].content), /a-completely-different-model/);
  });

  test('counts the conversation again without double counting it', () => {
    const thinker = makeThinker();
    const messages = systemFirst();

    thinker.load(messages);

    const { messages: before } = thinker.tokens;

    thinker.rebuild(messages);

    // the same messages measured by the same estimator - a rebuild that added
    // to the running total instead of replacing it would double this
    assert.equal(thinker.tokens.messages, before);
    assert.equal(
      thinker.tokens.total,
      thinker.tokens.system +
        thinker.tokens.skills +
        thinker.tokens.tools +
        thinker.tokens.messages
    );
  });

  test('drops back to an estimate ollama has not corrected', () => {
    const thinker = makeThinker();
    const messages = systemFirst();

    thinker.load(messages);
    thinker.tokens.measured = true;
    thinker.rebuild(messages);

    // the count ollama gave described a prompt another model's template
    // rendered, so it says nothing about what this one will be sent
    assert.equal(thinker.tokens.measured, false);
  });
});

describe('taking a turn', () => {
  const ask = (content = 'what does this do?'): Message[] => [
    { role: 'user', content }
  ];

  beforeEach(() => {
    chat.mock.resetCalls();
    abortClient.mock.resetCalls();
    stopWatching.mock.resetCalls();
    ollama.model = 'test-model';
    modelThinks = false;
    pressEscape = undefined;

    for (const tool of [echo, boom, silent]) {
      tool.handler.mock.resetCalls();
    }
  });

  afterEach(() => {
    ollama.think = undefined;
    ollama.replayPreamble = false;
    ollama.recoverToolCalls = true;
  });

  test('puts the system prompt first, once', async () => {
    const thinker = makeThinker();

    respond(chunk({ content: 'first' }));

    const first = await thinker.think({ messages: ask() });

    assert.equal(first.messages[0].role, 'system');
    assert.match(String(first.messages[0].content), /test-model/);

    respond(chunk({ content: 'second' }));

    const second = await thinker.think({
      messages: [...first.messages, ...ask('and then?')]
    });

    assert.equal(
      second.messages.filter((message) => message.role === 'system').length,
      1
    );
  });

  test('asks for a stream sized to the configured context', async () => {
    respond(chunk({ content: 'ok' }));

    await makeThinker().think({ messages: ask() });

    const [request] = requests();

    assert.equal(request.model, 'test-model');
    assert.equal(request.stream, true);
    assert.equal(request.keep_alive, ollama.keepAlive);
    assert.deepEqual(request.options, { num_ctx: ollama.contextLimit });
    assert.deepEqual(
      request.tools?.map((tool) => tool.function.name),
      ['echo', 'boom', 'silent']
    );
  });

  test('asks a model that can reason to do so', async () => {
    modelThinks = true;
    respond(chunk({ content: 'ok' }));

    await makeThinker().think({ messages: ask() });

    assert.equal(requests()[0].think, true);
  });

  test('leaves reasoning to the server default for a model that cannot', async () => {
    respond(chunk({ content: 'ok' }));

    await makeThinker().think({ messages: ask() });

    assert.equal(requests()[0].think, undefined);
  });

  test('lets an explicit setting win, even an explicit false', async () => {
    // the model says it can reason, and the user said not to
    modelThinks = true;
    ollama.think = false;
    respond(chunk({ content: 'ok' }));

    await makeThinker().think({ messages: ask() });

    assert.equal(requests()[0].think, false);
  });

  test('assembles the streamed reply into one message', async () => {
    const thinker = makeThinker();

    respond(
      chunk({ content: 'It does ' }),
      chunk({ content: 'nothing.' }),
      chunk({}, { done: true })
    );

    const result = await thinker.think({ messages: ask() });
    const reply = result.messages[result.messages.length - 1];

    assert.equal(reply.role, 'assistant');
    assert.equal(reply.content, 'It does nothing.');
    // callers read the reply from the response, and the final chunk alone
    // carries an empty one
    assert.equal(result.lastResponse?.message.content, 'It does nothing.');
    assert.equal(thinker.turnCount, 1);
    assert.equal(stopWatching.mock.callCount(), 1);
  });

  test('shows reasoning without keeping it', async () => {
    respond(
      chunk({ thinking: 'the user wants ' }),
      chunk({ thinking: 'a summary' }),
      chunk({ content: 'Here it is.' })
    );

    const { messages } = await makeThinker().think({ messages: ask() });
    const reply = messages[messages.length - 1];

    assert.equal(reply.content, 'Here it is.');
    assert.equal(reply.thinking, undefined);
    assert.ok(!JSON.stringify(messages).includes('a summary'));
  });

  test('answers every call, whatever became of it', async () => {
    // split across chunks, the way a model that calls several tools streams
    respond(
      chunk({
        tool_calls: [
          { function: { name: 'nope', arguments: {} } },
          { function: { name: 'echo', arguments: {} } }
        ]
      }),
      chunk({
        tool_calls: [
          { function: { name: 'boom', arguments: {} } },
          { function: { name: 'echo', arguments: { text: 'hi' } } },
          { function: { name: 'silent', arguments: {} } }
        ]
      })
    );

    const { messages } = await makeThinker().think({ messages: ask() });
    const results = toolResults(messages);

    assert.deepEqual(
      results.map((message) => message.tool_name),
      ['nope', 'echo', 'boom', 'echo', 'silent']
    );

    const [unknown, malformed, failed, echoed, empty] = results.map((message) =>
      String(message.content)
    );

    assert.match(unknown, /no tool called nope/);
    assert.match(unknown, /echo, boom, silent/);
    assert.match(malformed, /invalid arguments/);
    assert.match(malformed, /text is required/);
    assert.equal(failed, 'The boom tool failed: kaboom');
    assert.equal(echoed, JSON.stringify({ echoed: 'hi' }));
    assert.equal(empty, 'The tool returned no output.');
    // a malformed call never reaches the handler
    assert.equal(echo.handler.mock.callCount(), 1);
  });

  test('keeps the call but not the preamble that led up to it', async () => {
    respond(
      chunk({
        content: 'Let me check.',
        tool_calls: [{ function: { name: 'silent', arguments: {} } }]
      })
    );

    const result = await makeThinker().think({ messages: ask() });
    const call = result.messages.find((message) => message.tool_calls);

    assert.equal(call?.content, '');
    assert.equal(call?.tool_calls?.length, 1);
    // what was said still reaches the caller, which already showed it
    assert.equal(result.lastResponse?.message.content, 'Let me check.');
  });

  test('keeps the preamble when the setting asks for it', async () => {
    ollama.replayPreamble = true;
    respond(
      chunk({
        content: 'Let me check.',
        tool_calls: [{ function: { name: 'silent', arguments: {} } }]
      })
    );

    const { messages } = await makeThinker().think({ messages: ask() });

    assert.equal(
      messages.find((message) => message.tool_calls)?.content,
      'Let me check.'
    );
  });

  test('runs a qwen XML call written at the bottom of the reply', async () => {
    const said =
      'Let me repeat that.\n\n<tool_call>\n<function=echo>\n<parameter=text>\nhello\n</parameter>\n</function>\n</tool_call>';

    ollama.replayPreamble = true;
    // split across chunks, the way it streams
    respond(
      chunk({ content: said.slice(0, 30) }),
      chunk({ content: said.slice(30) })
    );

    const result = await makeThinker().think({ messages: ask() });
    const [echoed] = toolResults(result.messages);
    const call = result.messages.find((message) => message.tool_calls);

    assert.equal(echoed.tool_name, 'echo');
    assert.equal(echoed.content, JSON.stringify({ echoed: 'hello' }));
    // history holds the call as a call, and only the prose as text
    assert.deepEqual(call?.tool_calls, [
      { function: { name: 'echo', arguments: { text: 'hello' } } }
    ]);
    assert.equal(call?.content, 'Let me repeat that.');
    // the caller still sees what was said, and that the turn made a call
    assert.equal(result.lastResponse?.message.content, said);
    assert.equal(result.lastResponse?.message.tool_calls?.length, 1);
  });

  test('runs a JSON call the model wrote as its whole reply', async () => {
    respond(
      chunk({ content: '{"name": "echo", "arguments": {"text": "hi"}}' })
    );

    const result = await makeThinker().think({ messages: ask() });
    const results = toolResults(result.messages);

    assert.equal(echo.handler.mock.callCount(), 1);
    assert.deepEqual(
      results.map((message) => message.content),
      [JSON.stringify({ echoed: 'hi' })]
    );
    assert.equal(result.lastResponse?.message.tool_calls?.length, 1);
  });

  test('validates a recovered call like any other', async () => {
    respond(
      chunk({
        content: '<tool_call>\n<function=echo>\n</function>\n</tool_call>'
      })
    );

    const { messages } = await makeThinker().think({ messages: ask() });

    assert.match(String(toolResults(messages)[0].content), /text is required/);
    assert.equal(echo.handler.mock.callCount(), 0);
  });

  test('leaves a turn that made its calls properly alone', async () => {
    respond(
      chunk({
        content: '{"name": "echo", "arguments": {"text": "written"}}',
        tool_calls: [{ function: { name: 'silent', arguments: {} } }]
      })
    );

    const { messages } = await makeThinker().think({ messages: ask() });

    assert.deepEqual(
      toolResults(messages).map((message) => message.tool_name),
      ['silent']
    );
    assert.equal(echo.handler.mock.callCount(), 0);
  });

  test('recovers nothing when the setting is off', async () => {
    ollama.recoverToolCalls = false;
    respond(
      chunk({ content: '{"name": "echo", "arguments": {"text": "hi"}}' })
    );

    const result = await makeThinker().think({ messages: ask() });

    assert.equal(toolResults(result.messages).length, 0);
    assert.equal(echo.handler.mock.callCount(), 0);
    assert.equal(result.lastResponse?.message.tool_calls, undefined);
  });

  test('keeps nothing of a reply that said nothing', async () => {
    respond(chunk({}, { done: true }));

    const { messages } = await makeThinker().think({ messages: ask() });

    assert.deepEqual(
      messages.map((message) => message.role),
      ['system', 'user']
    );
  });

  test('believes the server over its own estimate once it has answered', async () => {
    const thinker = makeThinker();

    respond(
      chunk({ content: 'hello' }),
      chunk(
        {},
        {
          done: true,
          prompt_eval_count: 1000,
          eval_count: 20,
          eval_duration: 1e9
        }
      )
    );

    assert.equal(thinker.tokens.measured, false);

    await thinker.think({ messages: ask('hi') });

    // the server counted the prompt as sent; the reply that came back after
    // it is still the estimator's to count
    assert.equal(thinker.tokens.measured, true);
    assert.equal(thinker.tokens.total, 1000 + estimateTokens('hello'));
  });

  test('hands a failed request back to the caller', async () => {
    chat.mock.mockImplementationOnce(async () => {
      throw new Error('connection refused');
    });

    await assert.rejects(
      makeThinker().think({ messages: ask() }),
      /connection refused/
    );
    // escape must stop being watched even when the turn never started
    assert.equal(stopWatching.mock.callCount(), 1);
  });

  test('rolls the turn back when escape is pressed mid-stream', async () => {
    const thinker = makeThinker();
    const lastState = { messages: ask() };

    chat.mock.mockImplementationOnce(async () =>
      (async function* () {
        yield chunk({
          content: 'Half an ans',
          tool_calls: [{ function: { name: 'boom', arguments: {} } }]
        });
        pressEscape?.();
        // what the client's abort does to a stream that is being read
        throw new Error('The operation was aborted');
      })()
    );

    const result = await thinker.think(lastState);

    assert.equal(result.interrupted, true);
    assert.equal(result.messages, lastState.messages);
    assert.equal(abortClient.mock.callCount(), 1);
    // a call that may have been cut short is never dispatched
    assert.equal(boom.handler.mock.callCount(), 0);
  });

  // a model still being loaded holds the response back, and until it arrives
  // the client has nothing it can abort
  const pendingResponse = () => {
    let resolve!: (value: unknown) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });

    chat.mock.mockImplementationOnce(() => {
      queueMicrotask(() => pressEscape?.());

      return promise;
    });

    return { resolve, reject };
  };

  test('rolls the turn back when escape is pressed before the response', async () => {
    const thinker = makeThinker();
    const lastState = { messages: ask() };
    const response = pendingResponse();

    const result = await thinker.think(lastState);

    assert.equal(result.interrupted, true);
    assert.equal(result.messages, lastState.messages);
    assert.equal(stopWatching.mock.callCount(), 1);

    // the response that finally turns up is closed rather than read
    const late = {
      abort: mock.fn(),
      async *[Symbol.asyncIterator]() {
        yield chunk({ content: 'too late' });
      }
    };

    response.resolve(late);
    await new Promise((done) => setImmediate(done));

    assert.equal(late.abort.mock.callCount(), 1);
  });

  test('ignores a request that fails after escape was pressed', async () => {
    const response = pendingResponse();
    const result = await makeThinker().think({ messages: ask() });

    assert.equal(result.interrupted, true);

    // would surface as an unhandled rejection and fail the run
    response.reject(new Error('connection reset'));
    await new Promise((done) => setImmediate(done));
  });
});

describe('summarizing when eliding is not enough', () => {
  // text rather than tool output, so there is nothing for the cheap tier to
  // drop and only a summary can bring this under the target
  const talk = (): Message[] => {
    const turn = 'x'.repeat(Math.ceil(ollama.contextLimit * 0.2 * 3.33));

    return [
      { role: 'user', content: turn },
      { role: 'assistant', content: turn },
      { role: 'user', content: turn },
      { role: 'assistant', content: turn }
    ];
  };

  const summarizeAs = (content: string) =>
    chat.mock.mockImplementationOnce(async () => ({
      message: { role: 'assistant', content }
    }));

  beforeEach(() => {
    chat.mock.resetCalls();
  });

  test('replaces the older turns with notes on them', async () => {
    const thinker = makeThinker();
    const messages = talk();

    thinker.load(messages);
    summarizeAs('the user asked twice about x');

    const compacted = await thinker.compact(messages);
    const [notes, ...recent] = compacted.messages as AgentMessage[];

    assert.ok(compacted.freed > 0);
    assert.equal(notes.role, 'user');
    assert.equal(notes.summary, true);
    assert.match(String(notes.content), /the user asked twice about x/);
    // the latest exchange is what the model is working on, so it survives
    assert.deepEqual(recent, messages.slice(2));
    assert.ok(thinker.tokens.total <= ollama.contextLimit * 0.5);
  });

  test('asks for notes without offering any tools', async () => {
    const thinker = makeThinker();
    const messages = talk();

    thinker.load(messages);
    summarizeAs('notes');
    await thinker.compact(messages);

    const [request] = requests();

    assert.equal(request.tools, undefined);
    assert.equal(request.stream, undefined);
    assert.deepEqual(
      request.messages?.map((message) => message.role),
      ['user', 'assistant', 'user']
    );
  });

  test('keeps the turns when the summary would cost more than they do', async () => {
    const thinker = makeThinker();
    const messages = talk();

    thinker.load(messages);

    const before = thinker.tokens.total;

    summarizeAs('y'.repeat(ollama.contextLimit * 4));

    const compacted = await thinker.compact(messages);

    assert.equal(compacted.messages, messages);
    assert.equal(compacted.freed, 0);
    // the running totals describe the messages that were kept
    assert.equal(thinker.tokens.total, before);
  });

  test('does not ask for a summary when nothing can be split off', async () => {
    const thinker = makeThinker();
    const messages: Message[] = [
      { role: 'user', content: 'x'.repeat(ollama.contextLimit * 3) }
    ];

    thinker.load(messages);

    const compacted = await thinker.compact(messages);

    assert.equal(compacted.messages, messages);
    assert.equal(compacted.freed, 0);
    assert.equal(chat.mock.callCount(), 0);
  });
});

describe('recapping the last few turns', () => {
  const talk = (): Message[] => [
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'first reply' },
    { role: 'user', content: 'second' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ function: { name: 'read', arguments: { path: 'a.ts' } } }]
    },
    { role: 'tool', tool_name: 'read', content: 'file contents' },
    { role: 'assistant', content: 'second reply' }
  ];

  const recapAs = (content: string) =>
    chat.mock.mockImplementationOnce(async () => ({
      message: { role: 'assistant', content }
    }));

  let recapTurns: number;

  beforeEach(() => {
    chat.mock.resetCalls();
    recapTurns = session.recapTurns;
    session.recapTurns = 1;
  });

  afterEach(() => {
    session.recapTurns = recapTurns;
  });

  test('asks for a recap of only the turns in the window', async () => {
    const thinker = makeThinker();

    recapAs('  you asked about a.ts  ');

    assert.equal(await thinker.recap(talk()), 'you asked about a.ts');

    const [request] = requests();
    const [message] = request.messages ?? [];

    assert.equal(request.tools, undefined);
    assert.equal(request.messages?.length, 1);
    assert.equal(message.role, 'user');
    assert.match(message.content, /User: second\n\nAssistant: second reply$/);
    assert.doesNotMatch(message.content, /first|file contents/);
  });

  test('counts nothing, since the recap is never sent back', async () => {
    const thinker = makeThinker();
    const messages = talk();

    thinker.load(messages);

    const before = { ...thinker.tokens };

    recapAs('a recap');
    await thinker.recap(messages);

    assert.deepEqual(thinker.tokens, before);
  });

  test('asks for nothing when recaps are off', async () => {
    session.recapTurns = 0;

    assert.equal(await makeThinker().recap(talk()), undefined);
    assert.equal(chat.mock.callCount(), 0);
  });

  test('gives up quietly when the model call fails', async () => {
    chat.mock.mockImplementationOnce(async () => {
      throw new Error('connection refused');
    });

    assert.equal(await makeThinker().recap(talk()), undefined);
  });

  test('gives up quietly when the model says nothing', async () => {
    recapAs('   ');

    assert.equal(await makeThinker().recap(talk()), undefined);
  });
});

describe('starting the conversation over', () => {
  const history = (): Message[] => [
    { role: 'user', content: 'x'.repeat(400) },
    { role: 'assistant', content: 'y'.repeat(400) }
  ];

  test('load counts what it was handed and forgets the last measurement', () => {
    const thinker = makeThinker();

    thinker.tokens.measured = true;

    const counted = thinker.load(history());

    assert.equal(counted, 2 * estimateTokens('x'.repeat(400)));
    assert.equal(thinker.tokens.messages, counted);
    assert.equal(thinker.tokens.measured, false);
    assert.equal(thinker.turnCount, 0);
  });

  test('reset drops the conversation but not what every turn pays', () => {
    const thinker = makeThinker();
    const counted = thinker.load(history());

    thinker.tokens.measured = true;

    assert.equal(thinker.reset(), counted);
    assert.equal(thinker.tokens.messages, 0);
    assert.equal(
      thinker.tokens.total,
      thinker.tokens.system + thinker.tokens.skills + thinker.tokens.tools
    );
    assert.ok(thinker.tokens.system > 0);
    assert.equal(thinker.tokens.measured, false);
    assert.equal(thinker.turnCount, 0);
  });
});

describe('counting the skills on offer', () => {
  afterEach(() => {
    skillsBlock = undefined;
  });

  test('costs nothing when there are no skills', () => {
    assert.equal(makeThinker().tokens.skills, 0);
  });

  test('counts them apart from the rest of the system prompt', () => {
    const bare = makeThinker().tokens.system;

    skillsBlock = `## Skills\n\n${'a skill description '.repeat(40)}`;

    const { tokens } = makeThinker();

    assert.equal(tokens.skills, estimateTokens(skillsBlock));
    // carved out of the prompt they are sent in, not counted on top of it
    assert.ok(Math.abs(tokens.system - bare) <= 1);
    assert.equal(
      tokens.total,
      tokens.system + tokens.skills + tokens.tools + tokens.messages
    );
  });
});

describe('rebuilding onto a model with no system prompt', () => {
  afterEach(() => {
    promptBlank = false;
  });

  test('drops the stale prompt rather than leave it in place', () => {
    const thinker = makeThinker();
    const messages: Message[] = [
      { role: 'system', content: 'built for the model being left behind' },
      { role: 'user', content: 'hello' }
    ];

    promptBlank = true;
    thinker.rebuild(messages);

    assert.deepEqual(
      messages.map((message) => message.role),
      ['user']
    );
    assert.equal(thinker.tokens.system, 0);
  });
});

describe('the spinner', () => {
  const ask = (): Message[] => [{ role: 'user', content: 'go on then' }];
  const wasTTY = process.stdin.isTTY;

  beforeEach(() => {
    ora.mock.resetCalls();
    startSpinner.mock.resetCalls();
    stopSpinner.mock.resetCalls();
    spinning = false;
    // escape can only be pressed at a terminal, so that is when it is offered
    process.stdin.isTTY = true;
  });

  afterEach(() => {
    process.stdin.isTTY = wasTTY;
  });

  const cleared = () => {
    assert.equal(startSpinner.mock.callCount(), 1);
    assert.equal(stopSpinner.mock.callCount(), 1);
  };

  test('leaves stdin to the interrupt watcher', async () => {
    respond(chunk({ content: 'ok' }));

    await makeThinker().think({ messages: ask() });

    assert.equal(ora.mock.calls[0].arguments[0].discardStdin, false);
  });

  test('is taken back once the reply starts, and only once', async () => {
    // reasoning and then content - both write, and the second must not wipe
    // out a line the first already put there
    respond(
      chunk({ thinking: 'hmm' }),
      chunk({ content: 'Right, ' }),
      chunk({ content: 'here goes.' })
    );

    await makeThinker().think({ messages: ask() });

    cleared();
  });

  test('is taken back by a turn that never wrote a thing', async () => {
    // a call with no preamble streams nothing, so nothing overwrote the hint
    respond(
      chunk({ tool_calls: [{ function: { name: 'silent', arguments: {} } }] })
    );

    await makeThinker().think({ messages: ask() });

    cleared();
  });

  test('is taken back when the request fails', async () => {
    chat.mock.mockImplementationOnce(async () => {
      throw new Error('connection refused');
    });

    await assert.rejects(makeThinker().think({ messages: ask() }));

    cleared();
  });

  test('is never shown when input is piped', async () => {
    process.stdin.isTTY = false;
    respond(chunk({ content: 'ok' }));

    await makeThinker().think({ messages: ask() });

    assert.equal(startSpinner.mock.callCount(), 0);
    assert.equal(stopSpinner.mock.callCount(), 0);
  });
});
