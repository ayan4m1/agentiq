import { listJobs, readJob } from '../modules/jobs';
import { makeParameter, makeTool } from '../utils';

export const definition = makeTool(
  'read_job',
  'Returns whatever a background job has printed since the last time it was read, along with whether it is still running. Omit the id to list every job instead.',
  [
    makeParameter(
      'number',
      'id',
      'The job to read, as returned by run_background. Omit to list all jobs',
      false
    )
  ]
);

type Args = {
  id?: number;
};

export const handler = async ({ id }: Args) =>
  id === undefined ? listJobs() : readJob(id);
