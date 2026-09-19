import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';

import { handler } from './stop_job';
import { killAllJobs, listJobs, startJob } from '../modules/jobs';

after(() => {
  killAllJobs();
});

// jobs are process-wide, so these run in order: nothing started, then one
describe('stop_job', () => {
  test('says so when there is no such job', async () => {
    assert.equal(
      await handler({ id: 3 }),
      'There is no job 3 - no background jobs have been started.'
    );
  });

  test('stops a running job', async () => {
    const command = 'node -e "setInterval(() => {}, 1000)"';
    const id = startJob(command, process.cwd());

    assert.equal(await handler({ id }), `Stopped job ${id} (${command}).`);
    assert.match(listJobs(), new RegExp(`^${id} \\[stopped\\]`));
  });

  test('does not stop a job twice', async () => {
    assert.equal(
      await handler({ id: 1 }),
      'Job 1 is not running - it stopped.'
    );
  });

  test('names the jobs there are when the id is wrong', async () => {
    assert.equal(
      await handler({ id: 9 }),
      'There is no job 9. Current jobs: 1'
    );
  });
});
