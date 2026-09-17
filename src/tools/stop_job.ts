import { stopJob } from '../modules/jobs';
import { makeParameter, makeTool } from '../utils';

export const definition = makeTool(
  'stop_job',
  'Stops a background job and everything it started',
  [
    makeParameter(
      'number',
      'id',
      'The job to stop, as returned by run_background',
      true
    )
  ]
);

type Args = {
  id: number;
};

// no approval prompt - stopping something the agent started is never the
// dangerous direction, and asking would strand jobs when the answer is no
export const handler = async ({ id }: Args) => stopJob(id);
