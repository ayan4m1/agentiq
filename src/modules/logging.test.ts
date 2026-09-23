import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

// the labelled format is only used when detailed logging is on, and config is
// read as it is imported - so this has to be set before logging loads it
process.env.AQ_LOG_DETAILED = 'true';

const { getLogger } = await import('./logging');

describe('getLogger', () => {
  test('hands back the same logger for the same category', () => {
    assert.equal(getLogger('same'), getLogger('same'));
  });

  test('keeps categories apart', () => {
    assert.notEqual(getLogger('first'), getLogger('second'));
  });

  test('labels each line with its category', () => {
    const lines: string[] = [];
    const logger = getLogger('labelled');

    // the console transport formats first, so the finished line is what it is
    // handed to write
    logger.transports[0].log = (info: Record<symbol, string>, next) => {
      lines.push(info[Symbol.for('message')]);
      next();
    };
    logger.error('something happened');

    assert.deepEqual(lines, ['[error][labelled] something happened']);
  });

  test('labels with the label it was given in place of the category', () => {
    const lines: string[] = [];
    const logger = getLogger('relabelled', 'shown');

    logger.transports[0].log = (info: Record<symbol, string>, next) => {
      lines.push(info[Symbol.for('message')]);
      next();
    };
    logger.error('something happened');

    assert.deepEqual(lines, ['[error][shown] something happened']);
  });
});
