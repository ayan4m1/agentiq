import inquirer from 'inquirer';
import { execSync } from 'node:child_process';

import { shell } from '../modules/config';
import { getContentBudget, makeParameter, makeTool, truncate } from '../utils';

const maxLength = getContentBudget(0.2);

export const definition = makeTool('shell', 'Access a shell to run commands', [
  makeParameter('string', 'command', 'The command to execute', true),
  makeParameter('string', 'cwd', 'The working directory to execute in', true)
]);

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
  const { proceed } = await inquirer.prompt({
    type: 'confirm',
    name: 'proceed',
    message: `OK to run command "${command}"?`,
    default: false
  });

  if (!proceed) {
    return 'The user declined to run the command.';
  }

  try {
    // handing the command to execSync's own shell option avoids wrapping it in
    // quotes we would then have to escape - the command the user approved is
    // the exact string that runs
    return truncate(
      execSync(command, {
        cwd,
        shell: shell.path,
        // execSync is blocking, so a dev server or a hung install would wedge
        // the agent with no way back to the prompt
        timeout: shell.timeout,
        maxBuffer: maxLength * 4,
        encoding: 'utf-8'
      }).trim(),
      maxLength
    );
  } catch (error) {
    if (error instanceof Error) {
      const execError = error as ExecSyncError;

      if ('signal' in execError && execError.signal === 'SIGTERM') {
        return `The command timed out after ${shell.timeout}ms and was killed.`;
      }

      return truncate(
        `Error: ${execError.stderr}\n\nOutput: ${execError.stdout}`,
        maxLength
      );
    }

    return `The command failed: ${String(error)}`;
  }
};
