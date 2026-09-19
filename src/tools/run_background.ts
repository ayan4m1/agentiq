import { startJob } from '../modules/jobs';
import {
  describeDenial,
  refusePlanning,
  requestApproval
} from '../modules/approval';
import { makeParameter, makeTool } from '../utils';

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
  const refusal = refusePlanning('no commands can be run');

  if (refusal) {
    return refusal;
  }

  const { approved, reason } = await requestApproval(
    `OK to run "${command}" in the background?`,
    { kind: 'command', value: command }
  );

  if (!approved) {
    return describeDenial(`run "${command}"`, reason);
  }

  const id = startJob(command, cwd);

  return `Started job ${id}. Call read_job with id ${id} to see what it prints.`;
};
