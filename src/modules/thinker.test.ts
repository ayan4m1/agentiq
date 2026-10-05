import { test, describe, before, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { mkdtempSync } from 'node:fs';

import type {
  AgentMessage,
  ChatChunk,
  ChatMessage,
  ChatProvider,
  ChatStream
} from '../types';
import { fakeInterrupt } from '../../test/fakes/interrupt';
import { fakeOra } from '../../test/fakes/ora';
import { fakePreflight } from '../../test/fakes/preflight';
import type { ModuleMock } from '../../test/fakes/module';

// an empty state directory means no cached tokenizer, so the thinker falls
// back to estimating - which keeps this fast and keeps the numbers below
// predictable. it also has to be set before the module first evaluates
process.env.AQ_HOME = mkdtempSync(resolve(tmpdir(), 'agentiq-thinker-'));

// whether to ask for reasoning is decided by preflight, which needs the
// server - so the answer is whatever the test says it is
let think: boolean | undefined;

mock.module('./preflight', {
  exports: fakePreflight({ resolveThink: () => think }).exports
});

const { logging, ollama, provider, session } = await import('./config');
const { makeTool, makeParameter } = await import('../utils');

const interrupt = fakeInterrupt();
const spinner = fakeOra();

mock.module('./interrupt', { exports: interrupt.exports });
mock.module('ora', { exports: spinner.exports });

// the real prompt reads the working tree and the rules files. all that matters
// here is that it names the model, and that it can be switched off entirely
let promptBlank = false;
// the real skills block is read from ~/.agentiq/skills. the prompt below embeds
// it the way the real one does, so the thinker has something to carve out
let skillsBlock: string | undefined;

mock.module('./skills', {
  exports: { describeSkills: () => skillsBlock } satisfies ModuleMock<
    typeof import('./skills')
  >
});

mock.module('./prompt', {
  exports: {
    buildSystemPrompt: () =>
      promptBlank
        ? ''
        : [`You are running as ${provider.model}.`, skillsBlock]
            .filter(Boolean)
            .join('\n\n')
  } satisfies ModuleMock<typeof import('./prompt')>
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

// a test can add to this before making a thinker, so long as it takes it away
const tools = [echo, boom, silent];

mock.module('../tools', {
  exports: { tools } satisfies ModuleMock<typeof import('../tools')>
});

const { describeCache, makeThinker, replayable } = await import('./thinker');
const { chatProvider } = await import('../providers');
const { isElided } = await import('./compaction');
const { estimateTokens } = await import('./tokenizer');

// the server, as far as the thinker can tell. each test says what it answers -
// a turn streams, while a summary or a recap is asked for whole
const unanswered = async (): Promise<never> => {
  throw new Error('no response was set up for this test');
};
const stream = mock.method(
  chatProvider,
  'stream',
  unanswered as ChatProvider['stream']
);
const complete = mock.method(
  chatProvider,
  'complete',
  unanswered as ChatProvider['complete']
);
const abortProvider = mock.method(chatProvider, 'abort', () => {});
const requests = () => stream.mock.calls.map((call) => call.arguments[0]);
const asked = () => complete.mock.calls.map((call) => call.arguments[0]);

const chunk = (
  message: Partial<ChatMessage>,
  extra: Omit<ChatChunk, 'message'> = {}
): ChatChunk => ({
  message: { role: 'assistant', content: '', ...message },
  ...extra
});

// a stream with nothing behind it to abort
const asStream = (chunks: AsyncIterable<ChatChunk>): ChatStream => ({
  abort: () => {},
  [Symbol.asyncIterator]: () => chunks[Symbol.asyncIterator]()
});

const streamOf = (chunks: ChatChunk[]) =>
  asStream(
    (async function* () {
      yield* chunks;
    })()
  );

// the next turn streams these chunks back
const respond = (...chunks: ChatChunk[]) =>
  stream.mock.mockImplementationOnce(async () => streamOf(chunks));

// enough tool output to put the conversation well past the point where
// compaction has to do something about it
const bulk = 'x'.repeat(50_000);

const conversation = (): ChatMessage[] => [
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

const toolResults = (messages: ChatMessage[]) =>
  messages.filter((message) => message.role === 'tool');

describe('keeping a finished turn for the rounds that follow', () => {
  const preamble = (): ChatMessage => ({
    role: 'assistant',
    content: 'I will lay out a plan before touching anything.',
    tool_calls: [
      { function: { name: 'present_plan', arguments: { title: 'a plan' } } }
    ]
  });

  test('keeps a plain answer as it stands', () => {
    const answered: ChatMessage = {
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
  let messages: ChatMessage[];
  let freed: number;

  // the summarization tier is the one that needs a server, and eliding alone
  // gets this conversation under the target - so nothing here goes near one
  before(async () => {
    thinker = makeThinker();
    messages = conversation();
    thinker.load(messages);

    assert.ok(
      thinker.tokens.total > provider.contextLimit * 0.5,
      'the fixture has to start above the target for any of this to mean anything'
    );

    ({ freed } = await thinker.compact(messages));
  });

  test('reclaims context without asking the model for anything', () => {
    assert.ok(freed > 0);
  });

  test('brings the total under the target it aims for', () => {
    assert.ok(thinker.tokens.total <= provider.contextLimit * 0.5);
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
  const systemFirst = (): ChatMessage[] => [
    { role: 'system', content: 'built for the model being left behind' },
    { role: 'user', content: 'x'.repeat(400) },
    { role: 'assistant', content: 'y'.repeat(400) }
  ];

  test('names the model it was rebuilt on', () => {
    const thinker = makeThinker();
    const messages = systemFirst();

    provider.model = 'a-completely-different-model';
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

  test('drops back to an estimate the provider has not corrected', () => {
    const thinker = makeThinker();
    const messages = systemFirst();

    thinker.load(messages);
    thinker.tokens.measured = true;
    thinker.rebuild(messages);

    // the count the provider gave described a prompt another model's template
    // rendered, so it says nothing about what this one will be sent
    assert.equal(thinker.tokens.measured, false);
  });
});

describe('taking a turn', () => {
  const ask = (content = 'what does this do?'): ChatMessage[] => [
    { role: 'user', content }
  ];

  beforeEach(() => {
    stream.mock.resetCalls();
    abortProvider.mock.resetCalls();
    interrupt.reset();
    provider.model = 'test-model';
    think = undefined;

    for (const tool of [echo, boom, silent]) {
      tool.handler.mock.resetCalls();
    }
  });

  afterEach(() => {
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

  test('streams from the configured model with every tool', async () => {
    respond(chunk({ content: 'ok' }));

    await makeThinker().think({ messages: ask() });

    const [request] = requests();

    // sizing the window and keeping the model loaded are the provider's to
    // add, and are tested with it
    assert.equal(request.model, 'test-model');
    assert.deepEqual(
      request.tools?.map((tool) => tool.function.name),
      ['echo', 'boom', 'silent']
    );
  });

  test('sends whatever resolveThink() decides', async () => {
    for (const decided of [true, false, undefined]) {
      think = decided;
      respond(chunk({ content: 'ok' }));

      await makeThinker().think({ messages: ask() });

      assert.equal(requests().at(-1)?.think, decided);
    }
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
    assert.equal(interrupt.stopWatching.mock.callCount(), 1);
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

  test("keeps the provider's own record of the reply, and answers calls by id", async () => {
    const native = { provider: 'anthropic' as const, content: ['the blocks'] };

    respond(
      chunk({ content: 'Let me check.' }),
      chunk({
        tool_calls: [
          { id: 'toolu_1', function: { name: 'silent', arguments: {} } }
        ],
        native
      })
    );

    const result = await makeThinker().think({ messages: ask() });
    const call = result.messages.find((message) => message.tool_calls);
    const [answer] = toolResults(result.messages);

    // the preamble is dropped from history, but the record of it is not
    assert.equal(call?.content, '');
    assert.deepEqual(call?.native, native);
    assert.equal(answer.tool_call_id, 'toolu_1');
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
          usage: {
            promptTokens: 1000,
            outputTokens: 20,
            outputDurationNs: 1e9
          }
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
    stream.mock.mockImplementationOnce(async () => {
      throw new Error('connection refused');
    });

    await assert.rejects(
      makeThinker().think({ messages: ask() }),
      /connection refused/
    );
    // escape must stop being watched even when the turn never started
    assert.equal(interrupt.stopWatching.mock.callCount(), 1);
  });

  test('rolls the turn back when escape is pressed mid-stream', async () => {
    const thinker = makeThinker();
    const lastState = { messages: ask() };

    stream.mock.mockImplementationOnce(async () =>
      asStream(
        (async function* () {
          yield chunk({
            content: 'Half an ans',
            tool_calls: [{ function: { name: 'boom', arguments: {} } }]
          });
          interrupt.pressEscape();
          // what the provider's abort does to a stream that is being read
          throw new Error('The operation was aborted');
        })()
      )
    );

    const result = await thinker.think(lastState);

    assert.equal(result.interrupted, true);
    assert.equal(result.messages, lastState.messages);
    assert.equal(abortProvider.mock.callCount(), 1);
    // a call that may have been cut short is never dispatched
    assert.equal(boom.handler.mock.callCount(), 0);
  });

  // a model still being loaded holds the response back, and until it arrives
  // the provider has nothing it can abort
  const pendingResponse = () => {
    let resolve!: (value: ChatStream) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<ChatStream>((res, rej) => {
      resolve = res;
      reject = rej;
    });

    stream.mock.mockImplementationOnce(() => {
      queueMicrotask(() => interrupt.pressEscape());

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
    assert.equal(interrupt.stopWatching.mock.callCount(), 1);

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
  const talk = (): ChatMessage[] => {
    const turn = 'x'.repeat(Math.ceil(provider.contextLimit * 0.2 * 3.33));

    return [
      { role: 'user', content: turn },
      { role: 'assistant', content: turn },
      { role: 'user', content: turn },
      { role: 'assistant', content: turn }
    ];
  };

  const summarizeAs = (content: string) =>
    complete.mock.mockImplementationOnce(async () => ({
      role: 'assistant',
      content
    }));

  beforeEach(() => {
    complete.mock.resetCalls();
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
    assert.ok(thinker.tokens.total <= provider.contextLimit * 0.5);
  });

  test('asks for notes without offering any tools', async () => {
    const thinker = makeThinker();
    const messages = talk();

    thinker.load(messages);
    summarizeAs('notes');
    await thinker.compact(messages);

    const [request] = asked();

    assert.equal(request.tools, undefined);
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

    summarizeAs('y'.repeat(provider.contextLimit * 4));

    const compacted = await thinker.compact(messages);

    assert.equal(compacted.messages, messages);
    assert.equal(compacted.freed, 0);
    // the running totals describe the messages that were kept
    assert.equal(thinker.tokens.total, before);
  });

  test('does not ask for a summary when nothing can be split off', async () => {
    const thinker = makeThinker();
    const messages: ChatMessage[] = [
      { role: 'user', content: 'x'.repeat(provider.contextLimit * 3) }
    ];

    thinker.load(messages);

    const compacted = await thinker.compact(messages);

    assert.equal(compacted.messages, messages);
    assert.equal(compacted.freed, 0);
    assert.equal(complete.mock.callCount(), 0);
  });
});

describe('recapping the last few turns', () => {
  const talk = (): ChatMessage[] => [
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
    complete.mock.mockImplementationOnce(async () => ({
      role: 'assistant',
      content
    }));

  let recapTurns: number;

  beforeEach(() => {
    complete.mock.resetCalls();
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

    const [request] = asked();
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

  test('covers the turns it is asked to over the configured ones', async () => {
    recapAs('a recap');
    await makeThinker().recap(talk(), 2);

    const [message] = asked()[0].messages ?? [];

    assert.match(message.content, /User: first\n\nAssistant: first reply/);
    assert.match(message.content, /User: second\n\nAssistant: second reply$/);
  });

  test('covers every turn when asked for none', async () => {
    session.recapTurns = 0;
    recapAs('a recap');
    await makeThinker().recap(talk());

    const [message] = asked()[0].messages ?? [];

    assert.match(message.content, /User: first/);
    assert.match(message.content, /User: second/);
  });

  test('gives up quietly when the model call fails', async () => {
    complete.mock.mockImplementationOnce(async () => {
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
  const history = (): ChatMessage[] => [
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

describe('asking the provider to count', () => {
  const history = (): ChatMessage[] => [
    { role: 'user', content: 'x'.repeat(400) },
    { role: 'assistant', content: 'x'.repeat(400) }
  ];
  let countTokens: ReturnType<
    typeof mock.fn<NonNullable<ChatProvider['countTokens']>>
  >;

  beforeEach(() => {
    countTokens = mock.fn<NonNullable<ChatProvider['countTokens']>>(
      async () => 5000
    );
    chatProvider.countTokens = countTokens;
  });

  afterEach(() => {
    delete chatProvider.countTokens;
  });

  test('takes the count as the total', async () => {
    const thinker = makeThinker();
    const messages = history();

    thinker.load(messages);
    await thinker.count(messages);

    assert.equal(thinker.tokens.total, 5000);
    assert.equal(thinker.tokens.measured, true);
    assert.equal(thinker.tokens.messages, 2 * estimateTokens('x'.repeat(400)));
  });

  test('counts the request a turn would send', async () => {
    const thinker = makeThinker();

    await thinker.count(history());

    const [request] = countTokens.mock.calls[0].arguments;

    assert.equal(request.messages[0].role, 'system');
    assert.deepEqual(request.messages.slice(1), history());
    assert.ok(request.tools?.length);
  });

  test('keeps the estimate when the count fails', async () => {
    const thinker = makeThinker();
    const messages = history();

    thinker.load(messages);

    const estimate = thinker.tokens.total;

    countTokens.mock.mockImplementation(async () => {
      throw new Error('overloaded');
    });
    await thinker.count(messages);

    assert.equal(thinker.tokens.total, estimate);
    assert.equal(thinker.tokens.measured, false);
  });

  test('does nothing for a provider that cannot count', async () => {
    delete chatProvider.countTokens;

    const thinker = makeThinker();
    const estimate = thinker.tokens.total;

    await thinker.count([]);

    assert.equal(thinker.tokens.total, estimate);
    assert.equal(thinker.tokens.measured, false);
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

describe('counting the tools from mcp servers', () => {
  const remote = {
    definition: makeTool('mcp__docs__search', 'Searches the docs', [
      makeParameter('string', 'query', 'What to look for')
    ]),
    handler: mock.fn(async () => undefined)
  };

  afterEach(() => {
    const index = tools.indexOf(remote);

    if (index !== -1) {
      tools.splice(index, 1);
    }
  });

  test('costs nothing when no server has offered a tool', () => {
    assert.equal(makeThinker().tokens.mcp, 0);
  });

  test('counts them within the tools rather than on top of them', () => {
    const bare = makeThinker().tokens;

    tools.push(remote);

    const { tokens } = makeThinker();
    const cost = estimateTokens(JSON.stringify(remote.definition));

    assert.equal(tokens.mcp, cost);
    assert.equal(tokens.tools, bare.tools + cost);
    assert.equal(
      tokens.total,
      tokens.system + tokens.skills + tokens.tools + tokens.messages
    );
  });

  test('offers a server turned on from /mcp once rebuilt', async () => {
    const thinker = makeThinker();
    const countTokens = mock.fn<NonNullable<ChatProvider['countTokens']>>(
      async () => 5000
    );

    tools.push(remote);
    thinker.rebuild([]);
    chatProvider.countTokens = countTokens;

    try {
      await thinker.count([]);
    } finally {
      delete chatProvider.countTokens;
    }

    const [request] = countTokens.mock.calls[0].arguments;

    assert.equal(
      thinker.tokens.mcp,
      estimateTokens(JSON.stringify(remote.definition))
    );
    assert.ok(
      request.tools?.some((tool) => tool.function.name === 'mcp__docs__search')
    );
  });
});

describe('rebuilding onto a model with no system prompt', () => {
  afterEach(() => {
    promptBlank = false;
  });

  test('drops the stale prompt rather than leave it in place', () => {
    const thinker = makeThinker();
    const messages: ChatMessage[] = [
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
  const ask = (): ChatMessage[] => [{ role: 'user', content: 'go on then' }];
  const wasTTY = process.stdin.isTTY;

  beforeEach(() => {
    spinner.reset();
    // escape can only be pressed at a terminal, so that is when it is offered
    process.stdin.isTTY = true;
  });

  afterEach(() => {
    process.stdin.isTTY = wasTTY;
  });

  const cleared = () => {
    assert.equal(spinner.start.mock.callCount(), 1);
    assert.equal(spinner.stop.mock.callCount(), 1);
  };

  test('leaves stdin to the interrupt watcher', async () => {
    respond(chunk({ content: 'ok' }));

    await makeThinker().think({ messages: ask() });

    assert.equal(spinner.ora.mock.calls[0].arguments[0].discardStdin, false);
  });

  test('is taken back once the reply starts, and only once', async () => {
    // every chunk of the answer writes, and a later one must not stop the
    // spinner again over a line an earlier one already put there
    respond(chunk({ content: 'Right, ' }), chunk({ content: 'here goes.' }));

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
    stream.mock.mockImplementationOnce(async () => {
      throw new Error('connection refused');
    });

    await assert.rejects(makeThinker().think({ messages: ask() }));

    cleared();
  });

  test('offers escape from the moment it appears', async () => {
    respond(chunk({ content: 'ok' }));

    await makeThinker().think({ messages: ask() });

    assert.equal(
      spinner.ora.mock.calls[0].arguments[0].suffixText,
      'esc to interrupt (0s)'
    );
  });

  test('counts up while waiting, and stops once taken back', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval', 'Date'] });

    // hold the response back, the way a model still loading would
    let answer!: () => void;
    stream.mock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = () => resolve(streamOf([chunk({ content: 'ok' })]));
        })
    );

    const turn = makeThinker().think({ messages: ask() });

    t.mock.timers.tick(90_000);
    assert.equal(spinner.lastSpinner?.suffixText, 'esc to interrupt (1m30s)');

    answer();
    await turn;

    t.mock.timers.tick(10_000);
    assert.equal(spinner.lastSpinner?.suffixText, 'esc to interrupt (1m30s)');
  });

  // streams reasoning, then notes whether the spinner was still up before
  // the answer arrives
  const spinningAfterThoughts = async () => {
    let during: boolean | undefined;

    stream.mock.mockImplementationOnce(async () =>
      asStream(
        (async function* () {
          yield chunk({ thinking: 'hmm' });
          during = spinner.spinning;
          yield chunk({ content: 'ok' });
        })()
      )
    );

    await makeThinker().think({ messages: ask() });

    return during;
  };

  test('keeps spinning through reasoning that is not logged', async () => {
    logging.logThoughts = false;

    assert.equal(await spinningAfterThoughts(), true);
    cleared();
  });

  test('is taken back for reasoning when logThoughts is on', async (t) => {
    logging.logThoughts = true;
    t.after(() => {
      logging.logThoughts = false;
    });

    assert.equal(await spinningAfterThoughts(), false);
    cleared();
  });

  test('is never shown when input is piped', async () => {
    process.stdin.isTTY = false;
    respond(chunk({ content: 'ok' }));

    await makeThinker().think({ messages: ask() });

    assert.equal(spinner.start.mock.callCount(), 0);
    assert.equal(spinner.stop.mock.callCount(), 0);
  });
});

describe('describeCache', () => {
  test('gives both figures when the server sends them', () => {
    assert.equal(
      describeCache({ readTokens: 300, writeTokens: 20 }),
      'Prompt cache: 300 read, 20 written'
    );
  });

  test('keeps a real zero', () => {
    assert.equal(
      describeCache({ readTokens: 0, writeTokens: 0 }),
      'Prompt cache: 0 read, 0 written'
    );
  });

  test('gives only the figure that was sent', () => {
    assert.equal(describeCache({ readTokens: 512 }), 'Prompt cache: 512 read');
  });

  test('says so rather than claiming a miss when nothing was sent', () => {
    assert.equal(describeCache({}), 'Prompt cache: not reported by the server');
  });
});
