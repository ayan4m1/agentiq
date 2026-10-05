import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { stripVTControlCharacters } from 'node:util';

import { createMarkdownStream, renderMarkdown } from './markdown';

const collect = () => {
  const written: string[] = [];
  const stream = createMarkdownStream((text) => written.push(text));
  const plain = () => stripVTControlCharacters(written.join(''));

  return { written, plain, ...stream };
};

describe('renderMarkdown', () => {
  test('drops the markers from a heading and inline markup', () => {
    assert.equal(stripVTControlCharacters(renderMarkdown('## Title')), 'Title');
    assert.equal(
      stripVTControlCharacters(renderMarkdown('some **bold** and `code`')),
      'some bold and code'
    );
  });
});

describe('createMarkdownStream', () => {
  test('holds a line back until its newline arrives', () => {
    const out = collect();

    out.push('## Ti');
    out.push('tle');
    assert.deepEqual(out.written, []);

    out.push('\nnext');
    assert.equal(out.plain(), 'Title\n');
  });

  test('keeps blank lines between paragraphs', () => {
    const out = collect();

    out.push('one\n\ntwo\n');

    assert.equal(out.plain(), 'one\n\ntwo\n');
  });

  test('draws list items with their numbering and inline markup', () => {
    const out = collect();

    out.push('- item **one**\n  - nested `two`\n1. first\n2. second\n');

    assert.equal(
      out.plain(),
      '• item one\n  • nested two\n1. first\n2. second\n'
    );
  });

  test('keeps the indent of a continuation line rather than reading it as code', () => {
    const out = collect();

    out.push('1. first\n    more of **it**\n');

    assert.equal(out.plain(), '1. first\n    more of it\n');
  });

  test('draws a blockquote without its marker', () => {
    const out = collect();

    out.push('> a *quote*\n');

    assert.equal(out.plain(), '│ a quote\n');
  });

  test('holds a fenced block until it closes, then writes it whole', () => {
    const out = collect();

    out.push('```ts\nconst x = 1;\n');
    assert.deepEqual(out.written, []);

    out.push('```\nafter\n');

    const [block, after] = out.written;

    assert.equal(stripVTControlCharacters(block).trim(), 'const x = 1;');
    assert.equal(stripVTControlCharacters(after), 'after\n');
  });

  test('only closes a fence on the marker that opened it', () => {
    const out = collect();

    out.push('````md\n```\ninner\n```\n');
    assert.deepEqual(out.written, []);

    out.push('````\n');
    assert.match(out.plain(), /inner/);
  });

  test('holds a table until the first line after it', () => {
    const out = collect();

    out.push('| a | b |\n|---|---|\n| 1 | 2 |\n');
    assert.deepEqual(out.written, []);

    out.push('after\n');

    assert.match(out.plain(), /│ a +│ b +│/);
    assert.match(out.plain(), /│ 1 +│ 2 +│/);
    assert.ok(out.plain().endsWith('after\n'));
  });

  test('flushes the held line and an unclosed fence', () => {
    const fenced = collect();

    fenced.push('```js\nlet y = 2;\n');
    fenced.flush();
    assert.equal(fenced.plain().trim(), 'let y = 2;');

    const partial = collect();

    partial.push('**done**');
    partial.flush();
    assert.equal(partial.plain(), 'done\n');

    partial.flush();
    assert.equal(partial.plain(), 'done\n');
  });

  test('ignores the carriage return of a CRLF line', () => {
    const out = collect();

    out.push('# Top\r\n');

    assert.equal(out.plain(), 'Top\n');
  });
});
