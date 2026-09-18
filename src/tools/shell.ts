import chalk from 'chalk';

import { shell } from '../modules/config';
import { watchForInterrupt } from '../modules/interrupt';
import { killTree, spawnCommand } from '../modules/jobs';
import {
  describeDenial,
  refusePlanning,
  requestApproval
} from '../modules/approval';
import {
  commandOutputBudget,
  makeParameter,
  makeTool,
  truncate
} from '../utils';
import { getLogger } from '../modules/logging';

const log = getLogger('shell');

export const definition = makeTool('shell', 'Access a shell to run commands', [
  makeParameter('string', 'command', 'The command to execute', true),
  makeParameter('string', 'cwd', 'The working directory to execute in', true)
]);

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
    `OK to run command "${command}"?`
  );

  if (!approved) {
    return describeDenial(`run "${command}"`, reason);
  }

  const startedAt = Date.now();
  let output = '';

  // the user watches the command work rather than a frozen prompt, which is
  // most of the point of not blocking on it
  const onData = (chunk: string) => {
    output += chunk;
    process.stdout.write(chalk.dim(chunk));
  };

  const { child, finished } = spawnCommand({ command, cwd, onData });

  let timedOut = false;
  let interrupted = false;

  // the model's turn is over by the time a tool runs, so nothing else owns
  // stdin and escape can be watched for here as well as during generation
  const stopWatching = watchForInterrupt(() => {
    interrupted = true;
    killTree(child);
  });
  const timer = setTimeout(() => {
    timedOut = true;
    killTree(child);
  }, shell.timeout);

  let outcome;

  try {
    outcome = await finished;
  } finally {
    clearTimeout(timer);
    stopWatching();
  }

  // whatever ran last probably did not end on a newline, and the next thing
  // printed is a prompt
  if (output && !output.endsWith('\n')) {
    process.stdout.write('\n');
  }

  const elapsed = Date.now() - startedAt;
  const body = truncate(output.trim(), commandOutputBudget);

  if (outcome.error) {
    log.debug(outcome.error);
    return `The command could not be started: ${outcome.error}`;
  }

  if (timedOut) {
    log.debug(`Command ${command} timed out after ${shell.timeout}ms`);
    return `The command timed out after ${shell.timeout}ms and was killed.${body ? `\n\nOutput so far:\n${body}` : ''}`;
  }

  if (interrupted) {
    log.debug(`User interrupted command after ${elapsed}ms`);
    return `The user interrupted the command after ${elapsed}ms.${body ? `\n\nOutput so far:\n${body}` : ''}`;
  }

  // killed by something other than our own timeout or interrupt - the exit code
  // is empty in that case, so without this the run reads as a clean success
  if (outcome.signal) {
    log.debug(`Process was killed by ${outcome.signal}`);
    return `The command was killed by ${outcome.signal} after ${elapsed}ms.${body ? `\n\nOutput so far:\n${body}` : ''}`;
  }

  if (outcome.code) {
    log.debug(`Process exited with code ${outcome.code}`);
    return `The command exited with code ${outcome.code}.${body ? `\n\nOutput:\n${body}` : ''}`;
  }

  return body || 'The command produced no output.';
};
