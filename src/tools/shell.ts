import { confirm } from '@inquirer/prompts';
import { makeParameter, makeTool } from '../utils';
import { spawn } from 'node:child_process';

export const definition = makeTool(
  'shell',
  'Access a system shell to run commands',
  [
    makeParameter('string', 'command', 'THe command to execute', true),
    makeParameter('string', 'cwd', 'The working directory to execute in', true)
  ]
);

type Args = {
  command: string;
  cwd: string;
};

export const handler = async ({ command, cwd }: Args) => {
  const proceed = await confirm({
    message: `OK to run command "${command}"?`,
    default: false
  });

  if (!proceed) {
    return;
  }

  spawn(command, {
    cwd
  });
};
