import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { mkdtempSync } from 'node:fs';
import type { Message } from 'ollama';

// an empty state directory means no cached tokenizer, so the thinker falls
// back to estimating - which keeps this fast and keeps the numbers below
// predictable. it also has to be set before the module first evaluates
process.env.AQ_HOME = mkdtempSync(resolve(tmpdir(), 'agentiq-thinker-'));

const { makeThinker, replayable } = await import('./ollama');
const { ollama } = await import('./config');
const { isElided } = await import('./compaction');

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
      thinker.tokens.system + thinker.tokens.tools + thinker.tokens.messages
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
