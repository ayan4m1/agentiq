import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';
import chalk from 'chalk';

import { pickModel, type PickerChoice } from './picker';

// the test runner is not a terminal, so chalk would otherwise drop every color
// and there would be no telling a missing model from any other
chalk.level = 1;

type Request = Parameters<typeof pickModel>[0];

const choices: PickerChoice[] = [
  { name: 'llama3', value: 'llama3' },
  { name: 'qwen3', value: 'qwen3' },
  { name: 'gemma3', value: 'gemma3' }
];

// the prompt is driven through streams of its own rather than the real
// terminal, with keys handed straight to the keypress listeners readline would
// otherwise feed
const open = async (overrides: Partial<Request> = {}) => {
  const input = new PassThrough();
  const output = new PassThrough();
  const remove = mock.fn<(value: string) => void>();
  let written = '';

  output.on('data', (chunk: Buffer) => {
    written += chunk.toString();
  });

  const answer = pickModel(
    { message: 'Pick a model', choices, remove, ...overrides },
    { input, output }
  );

  // the first render is deferred a tick for a stream that can buffer input
  await new Promise(setImmediate);

  return {
    answer,
    remove,
    // everything written since the last key, which is the render that key made
    screen: () => stripVTControlCharacters(written),
    raw: () => written,
    press: (name: string) => {
      written = '';
      input.emit('keypress', null, { name, ctrl: false, meta: false });
    }
  };
};

const activeLine = (screen: string) =>
  screen.split('\n').find((line) => line.includes('❯'));

// a prompt left waiting on a key would otherwise hang the run instead of failing
describe('pickModel', { timeout: 2000 }, () => {
  test('starts on the default choice', async () => {
    const picker = await open({ default: 'qwen3' });

    assert.match(activeLine(picker.screen())!, /qwen3/);

    picker.press('enter');

    assert.equal(await picker.answer, 'qwen3');
  });

  test('starts on the first choice when the default is not listed', async () => {
    const picker = await open({ default: 'mistral' });

    assert.match(activeLine(picker.screen())!, /llama3/);

    picker.press('return');

    assert.equal(await picker.answer, 'llama3');
  });

  test('shows the key help beneath the list', async () => {
    const picker = await open();
    const screen = picker.screen();

    for (const hint of ['esc cancel', '↑↓ navigate', '⏎ select', 'r remove']) {
      assert.ok(screen.includes(hint), `expected "${hint}" in:\n${screen}`);
    }

    picker.press('escape');
    await picker.answer;
  });

  test('moves down and up, wrapping at either end', async () => {
    const picker = await open();

    picker.press('up');
    assert.match(activeLine(picker.screen())!, /gemma3/);

    picker.press('down');
    assert.match(activeLine(picker.screen())!, /llama3/);

    picker.press('down');
    assert.match(activeLine(picker.screen())!, /qwen3/);

    picker.press('enter');

    assert.equal(await picker.answer, 'qwen3');
  });

  test('shows the chosen value once done', async () => {
    const picker = await open({ default: 'gemma3' });

    picker.press('enter');
    await picker.answer;

    assert.match(picker.screen(), /Pick a model gemma3/);
  });

  test('resolves with nothing on escape', async () => {
    const picker = await open();

    picker.press('escape');

    assert.equal(await picker.answer, undefined);
    assert.match(picker.screen(), /Pick a model cancelled/);
  });

  test('ignores keys once it has finished', async () => {
    const picker = await open();

    picker.press('enter');
    picker.press('down');
    picker.press('r');

    assert.equal(await picker.answer, 'llama3');
    assert.equal(picker.remove.mock.callCount(), 0);
  });

  test('colors a missing model red, highlighted or not', async () => {
    const picker = await open({
      choices: [
        { name: 'llama3', value: 'llama3' },
        { name: 'ghost', value: 'ghost', missing: true }
      ]
    });

    assert.ok(picker.raw().includes(chalk.red('ghost')));

    picker.press('down');

    assert.ok(picker.raw().includes(chalk.red('ghost')));
    assert.match(activeLine(picker.screen())!, /ghost/);

    picker.press('enter');

    // a missing model can still be chosen
    assert.equal(await picker.answer, 'ghost');
  });

  test('only shows a page of choices at a time', async () => {
    const many = Array.from({ length: 12 }, (_, index) => ({
      name: `model-${index}`,
      value: `model-${index}`
    }));
    const picker = await open({ choices: many });
    const listed = many.filter(({ name }) =>
      new RegExp(`\\b${name}\\b`).test(picker.screen())
    );

    assert.equal(listed.length, 7);

    picker.press('escape');
    await picker.answer;
  });

  describe('removal', () => {
    test('asks before removing the highlighted choice', async () => {
      const picker = await open({ default: 'qwen3' });

      picker.press('r');

      assert.match(picker.screen(), /Remove qwen3\? \(y\/N\)/);
      assert.ok(!picker.screen().includes('esc cancel'));
      assert.equal(picker.remove.mock.callCount(), 0);

      // escape only backs out of the question - it takes a second to cancel
      picker.press('escape');

      assert.equal(picker.remove.mock.callCount(), 0);
      assert.match(picker.screen(), /r remove/);

      picker.press('escape');

      assert.equal(await picker.answer, undefined);
    });

    test('removes it on y and moves to the next choice', async () => {
      const picker = await open({ default: 'qwen3' });

      picker.press('r');
      picker.press('y');

      assert.deepEqual(picker.remove.mock.calls[0].arguments, ['qwen3']);
      assert.ok(!picker.screen().includes('qwen3'));
      assert.match(activeLine(picker.screen())!, /gemma3/);
      assert.match(picker.screen(), /r remove/);

      picker.press('enter');

      assert.equal(await picker.answer, 'gemma3');
    });

    test('moves up when the last choice is removed', async () => {
      const picker = await open({ default: 'gemma3' });

      picker.press('r');
      picker.press('y');

      assert.deepEqual(picker.remove.mock.calls[0].arguments, ['gemma3']);
      assert.match(activeLine(picker.screen())!, /qwen3/);

      picker.press('enter');

      assert.equal(await picker.answer, 'qwen3');
    });

    test('keeps it on any key but y', async () => {
      const picker = await open({ default: 'qwen3' });

      picker.press('r');
      picker.press('n');

      assert.equal(picker.remove.mock.callCount(), 0);
      assert.match(activeLine(picker.screen())!, /qwen3/);
      assert.match(picker.screen(), /r remove/);

      // the key that declined is swallowed rather than acted on
      picker.press('r');
      picker.press('enter');

      assert.equal(picker.remove.mock.callCount(), 0);
      assert.match(activeLine(picker.screen())!, /qwen3/);

      picker.press('enter');

      assert.equal(await picker.answer, 'qwen3');
    });

    test('explains why a locked choice cannot be removed', async () => {
      const picker = await open({
        choices: [
          { name: 'llama3', value: 'llama3', locked: 'in use by this session' },
          { name: 'qwen3', value: 'qwen3' }
        ]
      });

      picker.press('r');

      assert.match(picker.screen(), /in use by this session/);
      assert.ok(!picker.screen().includes('Remove llama3?'));

      // the explanation lasts only until the next key
      picker.press('down');

      assert.ok(!picker.screen().includes('in use by this session'));

      picker.press('r');
      picker.press('y');

      assert.deepEqual(picker.remove.mock.calls[0].arguments, ['qwen3']);
      assert.equal(picker.remove.mock.callCount(), 1);

      picker.press('enter');

      assert.equal(await picker.answer, 'llama3');
    });
  });
});
