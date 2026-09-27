import ora from 'ora';
import chalk from 'chalk';
import { existsSync, readdirSync, readFileSync } from 'node:fs';

import { shell } from './config';
import { getLogger } from './logging';
import { killTree, spawnCommand } from './jobs';
import { watchForInterrupt } from './interrupt';
import { showElapsed } from './elapsed';
import { refusePlanning } from './approval';
import { setSessionCheck } from './session';
import { takeYield } from './turn';
import { askModel, describeError, getContentBudget, truncate } from '../utils';

const log = getLogger('check');

// the files that say how a project is built and tested, in whatever ecosystem
// it happens to be - the directory listing alone rarely says which command runs
const manifests = [
  // NodeJS
  'package.json',
  // Make
  'Makefile',
  'justfile',
  'Cargo.toml',
  'pyproject.toml',
  'setup.cfg',
  'tox.ini',
  'go.mod',
  // PHP
  'composer.json',
  // Ruby
  'Gemfile',
  'deno.json',
  // Maven
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'CMakeLists.txt',
  'CMakePresets.json',
  'AGENTIQ.md'
];

// one manifest should not crowd out the rest - a lockfile-sized package.json
// still has its scripts near the top
const manifestBudget = 4000;

// enough to see which test or rule broke, without scrolling the reply away
const tailLines = 20;

export const checkPrompt =
  'Below are the files at the root of a project and the contents of its build manifests. Reply with exactly one shell command, run from the project root, that tests, lints or type-checks the project and exits non-zero when something is wrong. It must not install dependencies, start a server or watcher, prompt for input, or change any source file. Reply with only the command - no explanation and no code fence. If no such command exists, reply with NONE.';

// the one piece of check state, read by the prompt line on every redraw. no
// command means check mode is off, which is how every session starts
export const check: { command?: string; status?: 'pass' | 'fail' } = {};

export const describeCheck = () => {
  if (!check.command) {
    return '';
  }

  if (check.status === 'pass') {
    return chalk.green('[✔]');
  }

  if (check.status === 'fail') {
    return chalk.red('[✘]');
  }

  return chalk.gray('[·]');
};

const describeProject = () => {
  const cwd = process.cwd();
  const listing = readdirSync(cwd, { withFileTypes: true })
    .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
    .join('\n');
  const contents = manifests
    .filter((name) => existsSync(name))
    .map(
      (name) =>
        `Contents of ${name}:\n${truncate(readFileSync(name).toString(), manifestBudget)}`
    );

  return truncate(
    [`Files in the project root:\n${listing}`, ...contents].join('\n\n'),
    getContentBudget()
  );
};

// models wrap a lone command in a fence or backticks however they are asked,
// and sometimes add a line of explanation after it anyway
export const parseCommand = (reply: string) => {
  const line = reply
    .split('\n')
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate && !candidate.startsWith('```'));
  const command = line?.replace(/^`+|`+$/g, '').trim();

  return command && command.toUpperCase() !== 'NONE' ? command : undefined;
};

// a single call with no tools - the model is being asked a question about the
// project, not handed a turn in the conversation, and nothing it says here is
// kept in the history
export const findCheckCommand = async () => {
  const spinner = ora({
    stream: process.stdout,
    discardStdin: false,
    text: 'Asking for a check command'
  });
  let stopClock = () => {};

  if (process.stdin.isTTY) {
    spinner.start();
    stopClock = showElapsed(spinner);
  }

  try {
    return parseCommand(
      await askModel([
        { role: 'user', content: `${checkPrompt}\n\n${describeProject()}` }
      ])
    );
  } catch (error) {
    log.warn(`Could not find a check command: ${describeError(error)}`);

    return;
  } finally {
    stopClock();

    if (spinner.isSpinning) {
      spinner.stop();
    }
  }
};

// a resumed session brings its command back as it was chosen - asking the
// model again could quietly swap it for a different one
export const restoreCheck = (command?: string) => {
  check.command = command;
  check.status = undefined;

  if (command) {
    log.info(chalk.green(`Check mode on: ${command}`));
  }
};

const enable = (command: string) => {
  check.command = command;
  check.status = undefined;
  setSessionCheck(command);
  log.info(chalk.green(`Check mode on: ${command}`));
};

// on asks the model to choose a command, and anything but on or off is taken
// as the command itself - the user knowing what to run beats a guess at it
export const setCheck = async (value?: string) => {
  if (value === undefined) {
    console.log(
      check.command
        ? chalk.green(`Check mode is on: ${check.command}`)
        : chalk.red('Check mode is off')
    );

    return;
  }

  if (value === 'off') {
    check.command = undefined;
    check.status = undefined;
    setSessionCheck(undefined);
    log.info(chalk.green('Check mode off'));

    return;
  }

  if (value !== 'on') {
    enable(value);

    return;
  }

  const command = await findCheckCommand();

  if (!command) {
    log.warn(chalk.red('No check command was found - check mode is off'));

    return;
  }

  enable(command);
};

// why a finished check did not pass, or nothing when it did
const describeFailure = (
  outcome: { code?: number; signal?: string; error?: string },
  timedOut: boolean,
  interrupted: boolean
) => {
  if (outcome.error) {
    return `could not be started: ${outcome.error}`;
  }

  if (timedOut) {
    return `timed out after ${shell.timeout}ms`;
  }

  if (interrupted) {
    return 'was interrupted';
  }

  if (outcome.signal) {
    return `was killed by ${outcome.signal}`;
  }

  if (outcome.code) {
    return `exited with code ${outcome.code}`;
  }

  return;
};

// runs once a turn has handed the keyboard back. it is not put to the user
// for approval - turning check mode on is what approved the command, and
// asking again after every turn would only train them to say yes
export const runCheck = async () => {
  const { command } = check;

  if (!command) {
    return;
  }

  if (refusePlanning('no commands can be run')) {
    log.info(chalk.gray('Check skipped: plan mode is active'));
    check.status = undefined;

    return;
  }

  // a stop answer given during the turn asks the run loop to hand control
  // back, but control is already back - left set, it would cut the next turn
  // short instead
  takeYield();

  const spinner = ora({
    stream: process.stdout,
    discardStdin: false,
    text: `Running ${command}`
  });
  let stopClock = () => {};

  if (process.stdin.isTTY) {
    spinner.start();
    stopClock = showElapsed(spinner);
  }

  let output = '';
  let timedOut = false;
  let interrupted = false;

  // buffered rather than streamed - the badge is the answer, and the output
  // only matters when it has something to explain
  const { child, finished } = spawnCommand({
    command,
    cwd: process.cwd(),
    onData: (chunk: string) => {
      output += chunk;
    }
  });
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
    stopClock();

    if (spinner.isSpinning) {
      spinner.stop();
    }
  }

  const failure = describeFailure(outcome, timedOut, interrupted);

  if (!failure) {
    check.status = 'pass';

    return;
  }

  check.status = 'fail';

  const tail = output.trimEnd().split('\n').slice(-tailLines).join('\n');

  if (tail) {
    console.log(chalk.gray(tail));
  }

  log.warn(chalk.red(`Check ${failure}: ${command}`));
};
