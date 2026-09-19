import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { unescapeContent } from './write';

describe('unescapeContent', () => {
  test('decodes literal line breaks in doubly encoded content', () => {
    assert.equal(unescapeContent('one\\ntwo\\n'), 'one\ntwo\n');
  });

  test('decodes quotes, tabs and backslashes along with line breaks', () => {
    assert.equal(
      unescapeContent('const a = \\"x\\\\y\\";\\n\\tb();'),
      'const a = "x\\y";\n\tb();'
    );
  });

  test('decodes line breaks even when the rest is not valid JSON', () => {
    assert.equal(unescapeContent('say "hi"\\nbye'), 'say "hi"\nbye');
  });

  test('decodes escaped CRLF line breaks', () => {
    assert.equal(unescapeContent('a\\r\\nb'), 'a\r\nb');
  });

  test('leaves content with real line breaks alone', () => {
    const content = 'console.log("a\\nb");\nnext();\n';

    assert.equal(unescapeContent(content), content);
  });

  test('leaves content without escaped line breaks alone', () => {
    assert.equal(unescapeContent('path\\to\\thing'), 'path\\to\\thing');
  });
});
