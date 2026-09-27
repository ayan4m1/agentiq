import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { showElapsed } from './elapsed';

describe('showElapsed', () => {
  test('starts at zero', (t) => {
    t.mock.timers.enable({ apis: ['setInterval', 'Date'] });

    const spinner = { suffixText: '' };
    const stop = showElapsed(spinner);

    assert.equal(spinner.suffixText, '(0s)');

    stop();
  });

  test('counts up once a second', (t) => {
    t.mock.timers.enable({ apis: ['setInterval', 'Date'] });

    const spinner = { suffixText: '' };
    const stop = showElapsed(spinner);

    t.mock.timers.tick(1_000);
    assert.equal(spinner.suffixText, '(1s)');

    t.mock.timers.tick(89_000);
    assert.equal(spinner.suffixText, '(1m30s)');

    stop();
  });

  test('describes the time however it is asked to', (t) => {
    t.mock.timers.enable({ apis: ['setInterval', 'Date'] });

    const spinner = { suffixText: '' };
    const stop = showElapsed(spinner, (elapsed) => `waiting ${elapsed}`);

    t.mock.timers.tick(5_000);
    assert.equal(spinner.suffixText, 'waiting 5s');

    stop();
  });

  test('stops counting once stopped', (t) => {
    t.mock.timers.enable({ apis: ['setInterval', 'Date'] });

    const spinner = { suffixText: '' };
    const stop = showElapsed(spinner);

    t.mock.timers.tick(2_000);
    stop();
    t.mock.timers.tick(10_000);

    assert.equal(spinner.suffixText, '(2s)');
  });
});
