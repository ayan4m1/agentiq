import { startJob } from '../modules/jobs';
import {
  describeDenial,
  isPlanning,
  requestApproval
} from '../modules/approval';
import { makeParameter, makeTool } from '../utils';
import { getLogger } from '../modules/logging';

const log = getLogger('run_background');

export const definition = makeTool(
  'run_background',
  'Runs a command in the background and returns straight away. Use this instead of shell for anything that does not finish on its own - dev servers, watch builds, log tails. Collect its output with read_job and end it with stop_job.',
  [
    makeParameter('string', 'command', 'The command to execute', true),
    makeParameter('string', 'cwd', 'The working directory to execute in', true)
  ]
);

type Args = {
  command: string;
  cwd: string;
};

export const handler = async ({ command, cwd }: Args) => {
  if (isPlanning()) {
    log.debug('Plan mode is active');
    return 'Plan mode is active, so no commands can be run. Use the present_plan tool to propose an approach and ask to start work.';
  }

  const { approved, reason } = await requestApproval(
    `OK to run "${command}" in the background?`
  );

  if (!approved) {
    return describeDenial(`run "${command}"`, reason);
  }

  const id = startJob(command, cwd);

  return `Started job ${id}. Call read_job with id ${id} to see what it prints.`;
};
