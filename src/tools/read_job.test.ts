import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';

import { handler } from './read_job';
import { killAllJobs, listJobs, startJob } from '../modules/jobs';

const waitFor = async (condition: () => boolean, timeout = 10000) => {
  const deadline = Date.now() + timeout;

  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error('Timed out waiting for the job');
    }

    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

after(() => {
  killAllJobs();
});

// jobs are process-wide, so these run in order: nothing started, then one
describe('read_job', () => {
  test('lists jobs when given no id', async () => {
    assert.equal(await handler({}), 'No background jobs have been started.');
  });

  test('says so when there is no such job', async () => {
    assert.equal(
      await handler({ id: 7 }),
      'There is no job 7 - no background jobs have been started.'
    );
  });

  test('returns what a job printed along with how it ended', async () => {
    const id = startJob(
      `node -e "console.log('hello from the job')"`,
      process.cwd()
    );

    await waitFor(() => /exited/.test(listJobs()));

    const output = await handler({ id });

    assert.match(output, new RegExp(`^Job ${id} \\[exited with code 0\\]`));
    assert.match(output, /hello from the job/);
  });

  test('does not replay output it has already returned', async () => {
    assert.match(await handler({ id: 1 }), /\[no new output\]$/);
  });

  test('lists the jobs that have been started', async () => {
    assert.match(await handler({}), /^1 \[exited with code 0\] node -e/);
  });
});
