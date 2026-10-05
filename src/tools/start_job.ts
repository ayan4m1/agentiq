import { startJob } from '../modules/jobs';
import {
  describeDenial,
  describeEditedCommand,
  refusePlanning,
  requestApproval
} from '../modules/approval';
import { makeParameter, makeTool } from '../utils';

export const definition = makeTool(
  'start_job',
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

  const ask = (text: string) => `OK to run "${text}" in the background?`;

  const { approved, reason, edited } = await requestApproval(
    ask(command),
    { kind: 'command', value: command },
    { content: command, show: ask }
  );

  if (!approved) {
    return describeDenial(`run "${command}"`, reason);
  }

  const id = startJob(edited ?? command, cwd);
  const result = `Started job ${id}. Call read_job with id ${id} to see what it prints.`;

  return edited === undefined
    ? result
    : `${describeEditedCommand(edited)} ${result}`;
};
