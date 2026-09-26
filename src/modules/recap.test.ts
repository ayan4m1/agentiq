import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { recentTurns, renderTranscript } from './recap';
import type { AgentMessage } from '../types';

const conversation: AgentMessage[] = [
  { role: 'user', content: 'what happened before', summary: true },
  { role: 'user', content: 'first' },
  { role: 'assistant', content: 'first reply' },
  { role: 'user', content: 'second' },
  {
    role: 'assistant',
    content: '',
    tool_calls: [{ function: { name: 'read', arguments: { path: 'a.ts' } } }]
  },
  { role: 'tool', tool_name: 'read', content: 'file contents' },
  { role: 'assistant', content: 'second reply', thinking: 'mulling it over' },
  { role: 'user', content: 'third' },
  { role: 'assistant', content: 'third reply' }
];

describe('recentTurns', () => {
  test('starts at the prompt that began the oldest turn in the window', () => {
    assert.deepEqual(
      recentTurns(conversation, 2).map(({ content }) => content),
      ['second', '', 'file contents', 'second reply', 'third', 'third reply']
    );
  });

  test('takes everything, notes included, when there are fewer turns', () => {
    assert.deepEqual(recentTurns(conversation, 10), conversation);
  });

  test('does not count compaction notes as a turn', () => {
    assert.equal(recentTurns(conversation, 3), conversation);
  });

  test('takes nothing when recaps are off', () => {
    assert.deepEqual(recentTurns(conversation, 0), []);
    assert.deepEqual(recentTurns(conversation, NaN), []);
  });
});

describe('renderTranscript', () => {
  test('keeps only what the user and the model said to each other', () => {
    assert.equal(
      renderTranscript(conversation),
      [
        'Earlier notes: what happened before',
        'User: first',
        'Assistant: first reply',
        'User: second',
        'Assistant: second reply',
        'User: third',
        'Assistant: third reply'
      ].join('\n\n')
    );
  });

  test('is empty when nobody has said anything', () => {
    assert.equal(renderTranscript([]), '');
    assert.equal(
      renderTranscript([{ role: 'tool', content: 'output only' }]),
      ''
    );
  });

  test('cuts a message that would crowd out the rest', () => {
    const transcript = renderTranscript([
      { role: 'user', content: 'x'.repeat(10_000) },
      { role: 'assistant', content: 'short' }
    ]);

    assert.match(transcript, /\[truncated: showing 2000 of 10000 characters\]/);
    assert.match(transcript, /Assistant: short$/);
  });
});
