import { confirm } from '@inquirer/prompts';
import { makeParameter, makeTool } from '../utils';
import { execSync } from 'node:child_process';

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

interface ExecSyncError extends Error {
  status: number;
  pid: number;
  stdout: string | Buffer;
  stderr: string | Buffer;
}

export const handler = async ({ command, cwd }: Args) => {
  const proceed = await confirm({
    message: `OK to run command "${command}"?`,
    default: false
  });

  if (!proceed) {
    return;
  }

  try {
    return execSync(`bash -c "${command.replace('"', '\\"')}"`, {
      cwd
    })
      .toString()
      .trim();
  } catch (error) {
    if (error instanceof Error) {
      const execError = error as ExecSyncError;
      return `Error: ${execError.stderr}\n\nOutput: ${execError.stdout}`;
    }
  }
};
