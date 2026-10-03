import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';
import chalk from 'chalk';

import {
  pickModel,
  pickSkills,
  toggleAll,
  type PickerChoice,
  type SkillChoice
} from './picker';

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

  describe('browsing', () => {
    test('closes on enter without choosing anything', async () => {
      const picker = await open({ browse: true });

      assert.match(picker.screen(), /esc\/⏎ close/);
      assert.ok(!picker.screen().includes('select'));

      picker.press('enter');

      assert.equal(await picker.answer, undefined);
      assert.ok(!picker.screen().includes('llama3'));
    });

    test('names a choice by its label when asking to remove it', async () => {
      const picker = await open({
        browse: true,
        choices: [
          {
            name: 'yarn test',
            value: 'command:yarn test',
            label: 'the rule yarn test'
          }
        ]
      });

      picker.press('r');

      assert.match(picker.screen(), /Remove the rule yarn test\? \(y\/N\)/);

      picker.press('n');
      picker.press('escape');
      await picker.answer;
    });

    test('finishes once the last choice is removed', async () => {
      const picker = await open({
        browse: true,
        choices: [{ name: 'llama3', value: 'llama3' }]
      });

      picker.press('r');
      picker.press('y');

      assert.deepEqual(picker.remove.mock.calls[0].arguments, ['llama3']);
      assert.equal(await picker.answer, undefined);
    });
  });
});

const skillChoices: SkillChoice[] = [
  { name: 'alpha', description: 'First skill', enabled: true },
  { name: 'beta', description: 'Second skill', enabled: false }
];

// the same streams as open() above, for the skills prompt
const openSkills = async (choices = skillChoices) => {
  const input = new PassThrough();
  const output = new PassThrough();
  const toggle = mock.fn<(name: string, enabled: boolean) => void>();
  let written = '';

  output.on('data', (chunk: Buffer) => {
    written += chunk.toString();
  });

  const answer = pickSkills(
    { message: 'Skills', choices, toggle },
    { input, output }
  );

  await new Promise(setImmediate);

  return {
    answer,
    toggle,
    input,
    screen: () => stripVTControlCharacters(written),
    press: (name: string) => {
      written = '';
      input.emit('keypress', null, { name, ctrl: false, meta: false });
    }
  };
};

describe('pickSkills', { timeout: 2000 }, () => {
  test('marks each skill on or off and describes the active one', async () => {
    const picker = await openSkills();
    const screen = picker.screen();

    assert.match(screen, /◉ alpha/);
    assert.match(screen, /◯ beta/);
    assert.match(screen, /First skill/);

    picker.press('down');

    assert.match(picker.screen(), /Second skill/);

    picker.press('escape');
    await picker.answer;
  });

  test('toggles the active skill with space as it goes', async () => {
    const picker = await openSkills();

    picker.press('space');

    assert.deepEqual(picker.toggle.mock.calls[0].arguments, ['alpha', false]);
    assert.match(picker.screen(), /◯ alpha/);

    picker.press('down');
    picker.press('space');

    assert.deepEqual(picker.toggle.mock.calls[1].arguments, ['beta', true]);

    picker.press('enter');
    await picker.answer;

    // alpha went off and beta came on
    assert.match(picker.screen(), /1 of 2 enabled/);
  });

  test('turns them all on with a, then all off', async () => {
    const picker = await openSkills();

    picker.press('a');

    // alpha was already on, so only beta changed
    assert.deepEqual(
      picker.toggle.mock.calls.map((call) => call.arguments),
      [['beta', true]]
    );

    picker.press('a');

    assert.deepEqual(
      picker.toggle.mock.calls.slice(1).map((call) => call.arguments),
      [
        ['alpha', false],
        ['beta', false]
      ]
    );

    picker.press('escape');
    await picker.answer;

    assert.match(picker.screen(), /0 of 2 enabled/);
  });

  test('stops reading the terminal before readline lets go of it', async () => {
    const picker = await openSkills();
    // what a tty stream has under it - a closing readline turns raw mode off,
    // and with this still reading windows queues a cooked read behind it
    const handle = { reading: true, readStop: mock.fn(() => 0) };

    Object.assign(picker.input, { _handle: handle });
    picker.press('escape');
    await picker.answer;

    assert.equal(handle.readStop.mock.callCount(), 1);
    assert.equal(handle.reading, false);
  });

  test('closes on escape without toggling anything', async () => {
    const picker = await openSkills();

    picker.press('escape');
    await picker.answer;

    assert.equal(picker.toggle.mock.callCount(), 0);
  });
});

describe('toggleAll', () => {
  test('turns everything on unless it already is', () => {
    assert.deepEqual(
      toggleAll(skillChoices).map(({ enabled }) => enabled),
      [true, true]
    );
    assert.deepEqual(
      toggleAll(toggleAll(skillChoices)).map(({ enabled }) => enabled),
      [false, false]
    );
  });
});
