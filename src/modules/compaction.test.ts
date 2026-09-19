import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { Message, ToolCall } from 'ollama';

import {
  describeElision,
  elidedPrefix,
  findSplit,
  isElided,
  pairCalls,
  safeBoundaries
} from './compaction';

const user = (content: string): Message => ({ role: 'user', content });

const calling = (...calls: ToolCall[]): Message => ({
  role: 'assistant',
  content: '',
  tool_calls: calls
});

const saying = (content: string): Message => ({ role: 'assistant', content });

const call = (name: string, args: Record<string, unknown>): ToolCall => ({
  function: { name, arguments: args }
});

const result = (name: string, content: string): Message => ({
  role: 'tool',
  tool_name: name,
  content
});

// one user message and nothing but tool calls after it: the shape a long task
// actually takes, and the one that used to free nothing at all
const singleLongTurn = () => [
  user('read the whole module and tell me what it does'),
  calling(call('read', { path: 'src/a.ts' })),
  result('read', 'contents of a'),
  calling(call('read', { path: 'src/b.ts' })),
  result('read', 'contents of b'),
  calling(call('read', { path: 'src/c.ts' })),
  result('read', 'contents of c')
];

// every call made before the cut has its result before the cut too
const isBalanced = (messages: Message[]) => {
  let outstanding = 0;

  for (const message of messages) {
    if (message.role === 'tool') {
      outstanding--;
    } else {
      outstanding += message.tool_calls?.length ?? 0;
    }
  }

  return outstanding === 0;
};

describe('pairCalls', () => {
  test('pairs a result with the call that produced it', () => {
    const messages = [
      user('go'),
      calling(call('read', { path: 'src/a.ts' })),
      result('read', 'contents')
    ];

    assert.equal(
      pairCalls(messages).get(2)?.function.arguments.path,
      'src/a.ts'
    );
  });

  test('pairs several results from one turn by position', () => {
    const messages = [
      user('go'),
      calling(
        call('read', { path: 'first.ts' }),
        call('read', { path: 'second.ts' })
      ),
      result('read', 'one'),
      result('read', 'two')
    ];
    const pairs = pairCalls(messages);

    assert.equal(pairs.get(2)?.function.arguments.path, 'first.ts');
    assert.equal(pairs.get(3)?.function.arguments.path, 'second.ts');
  });

  test('starts counting again at each assistant turn', () => {
    const messages = [
      user('go'),
      calling(call('read', { path: 'first.ts' })),
      result('read', 'one'),
      calling(call('find', { pattern: '**/*.ts' })),
      result('find', 'two')
    ];

    assert.equal(
      pairCalls(messages).get(4)?.function.arguments.pattern,
      '**/*.ts'
    );
  });

  test('pairs nothing for a result with no call before it', () => {
    assert.equal(pairCalls([result('read', 'orphan')]).size, 0);
  });
});

describe('describeElision', () => {
  test('is recognisable as a marker it wrote itself', () => {
    const marker = describeElision('x'.repeat(4000), 'read');

    assert.ok(marker.startsWith(elidedPrefix));
    assert.ok(isElided({ role: 'tool', content: marker }));
  });

  test('says how much went', () => {
    assert.match(describeElision('x'.repeat(4000), 'read'), /4000 characters/);
  });

  test('names the tool', () => {
    assert.match(describeElision('output', 'shell'), /from shell/);
  });

  test('names what the call was about', () => {
    const marker = describeElision(
      'output',
      'read',
      call('read', { path: 'src/modules/ollama.ts' })
    );

    assert.match(marker, /src\/modules\/ollama\.ts/);
  });

  test('tells the model it can ask again', () => {
    // without this it has to guess whether the output ever existed
    assert.match(describeElision('output', 'read'), /call it again/);
  });

  test('shortens an argument that would cost what it just reclaimed', () => {
    const marker = describeElision(
      'output',
      'shell',
      call('shell', { command: 'x'.repeat(500) })
    );

    assert.ok(marker.length < 200);
  });

  test('copes with a call whose arguments are not useful', () => {
    const marker = describeElision('output', 'read', call('read', {}));

    assert.ok(marker.startsWith(elidedPrefix));
    assert.match(marker, /from read/);
  });

  test('copes with no tool name at all', () => {
    assert.match(describeElision('output'), /from a tool/);
  });
});

describe('isElided', () => {
  test('is false for real output', () => {
    assert.equal(isElided(result('read', 'the actual contents')), false);
  });

  test('is false for a message with no content', () => {
    assert.equal(isElided({ role: 'assistant', content: '' }), false);
  });
});

describe('safeBoundaries', () => {
  test('never cuts between a call and its result', () => {
    const messages = [
      user('go'),
      calling(call('read', { path: 'a.ts' }), call('read', { path: 'b.ts' })),
      result('read', 'one'),
      result('read', 'two'),
      saying('done')
    ];

    // 2 and 3 sit inside the group and must not be offered
    assert.deepEqual(safeBoundaries(messages), [1, 4]);
  });

  test('offers no boundary at all before the first message', () => {
    assert.ok(!safeBoundaries([user('go'), saying('done')]).includes(0));
  });

  test('every boundary leaves a balanced prefix behind it', () => {
    const messages = singleLongTurn();

    for (const boundary of safeBoundaries(messages)) {
      assert.ok(
        isBalanced(messages.slice(0, boundary)),
        `cutting at ${boundary} orphans a tool result`
      );
    }
  });

  test('has nothing to offer for a single message', () => {
    assert.deepEqual(safeBoundaries([user('go')]), []);
  });
});

describe('findSplit', () => {
  test('prefers the last user message, keeping that turn whole', () => {
    const messages = [
      user('first'),
      saying('answer'),
      user('second'),
      saying('answer')
    ];

    assert.equal(findSplit(messages), 2);
  });

  test('finds a cut inside a single long turn', () => {
    // the dead end: one user message at index 0, so the old rule found
    // nothing to split on and compaction reclaimed nothing at all
    const messages = singleLongTurn();
    const splitAt = findSplit(messages);

    assert.ok(splitAt >= 1, 'a long single turn must still be splittable');
    assert.ok(isBalanced(messages.slice(0, splitAt)));
  });

  test('cuts as late as the pairing allows in a single turn', () => {
    assert.equal(findSplit(singleLongTurn()), 5);
  });

  test('refuses to split a conversation with nothing behind the cut', () => {
    assert.equal(findSplit([user('go')]), -1);
  });

  test('refuses to split an empty conversation', () => {
    assert.equal(findSplit([]), -1);
  });

  test('never picks a cut that would orphan a result', () => {
    const messages = [
      user('go'),
      calling(call('read', { path: 'a.ts' })),
      result('read', 'contents')
    ];

    assert.ok(isBalanced(messages.slice(0, findSplit(messages))));
  });
});
