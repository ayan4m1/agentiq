import chalk from 'chalk';
import inquirer from 'inquirer';
import Bottleneck from 'bottleneck';
import { program } from 'commander';
import InquirerCommandPrompt, { type KeyEvent } from 'inquirer-command-prompt';

import { ollama } from '../modules/config';
import { killAllJobs } from '../modules/jobs';
import { discardCheckpoints } from '../modules/checkpoints';
import { compactThreshold, makeThinker } from '../modules/ollama';
import { preflight } from '../modules/preflight';
import { ensureTokenizer } from '../modules/tokenizer';
import { cycleMode, describeMode } from '../modules/approval';
import { pruneSessions, startSession } from '../modules/session';
import { Command, createController, systemColor } from '../modules/repl';
import { getTokenString } from '../utils';

// commander runs this file as its own executable, so the options it was given
// arrive here rather than in src/index.ts - the supported spelling is
// `agentiq run --resume`, since the parent program owns the bare argv
const { resume } = program
  .allowUnknownOption()
  .allowExcessArguments()
  .option('--resume [id]', 'resume the most recent session, or one by id')
  .parse(process.argv)
  .opts();

// a missing model or an unreachable host is worth saying now rather than
// after the user has typed their first message - and before the tokenizer
// download, which is the slow part of starting up
if (!(await preflight())) {
  process.exit(1);
}

// makeThinker() tokenizes the system prompt and every tool definition up front,
// so the tokenizer has to be on disk before it runs
await ensureTokenizer();

const thinker = makeThinker();
// maxConcurrent is what matters here: turns must not overlap. minTime is for
// a metered remote endpoint and is zero by default
const rateLimiter = new Bottleneck({
  maxConcurrent: 1,
  minTime: ollama.minTurnDelay
});

// a dev server that outlives the session holds its port and is only noticed
// much later, so every way out of here goes through killAllJobs first. the
// snapshots go the same way: they exist so this session can be undone, and
// nothing reads them once it is over
const cleanUp = () => {
  killAllJobs();
  discardCheckpoints();
};

process.on('exit', cleanUp);
// ^C during generation is raised as a signal by modules/interrupt.ts, and
// listening for it replaces the default termination - so exit deliberately
process.on('SIGINT', () => {
  cleanUp();
  process.exit(130);
});

const renderPrompt = () =>
  `${systemColor(`${describeMode()}${getTokenString(thinker.tokens.messages)}`)}${chalk.blue('>')}`;

// the prompt's own tab branch has no shift guard, so shift+tab would otherwise
// fall into autocompletion and leave a literal tab in the buffer
class ModeCommandPrompt extends InquirerCommandPrompt {
  async onKeypress(event: KeyEvent) {
    if (event?.key?.name !== 'tab' || !event.key.shift) {
      return super.onKeypress(event);
    }

    cycleMode();

    // readline echoes the tab before the keypress reaches us
    this.rl.line = this.rl.line.replace(/\t/g, '');
    this.rl.cursor = this.rl.line.length;
    this.opt.message = renderPrompt();

    return this.render();
  }
}

inquirer.registerPrompt('command', ModeCommandPrompt);

const controller = createController({
  thinker,
  compactAt: ollama.contextLimit * compactThreshold
});

pruneSessions();

// a failed resume still needs somewhere to write what happens next
if (
  !resume ||
  !controller.restore(typeof resume === 'string' ? resume : undefined)
) {
  startSession();
}

while (true) {
  if (controller.needsUserInput) {
    //@ts-expect-error saveHistory must be a bool but inquirer doesn't allow that
    const { userMessage } = await inquirer.prompt({
      type: 'command',
      name: 'userMessage',
      message: renderPrompt(),
      saveHistory: true
    });

    if (userMessage.startsWith('/')) {
      if (
        (await controller.runCommand(userMessage.substring(1))) === Command.Quit
      ) {
        cleanUp();
        process.exit(0);
      }

      continue;
    }

    controller.addUserMessage(userMessage);
  }

  await controller.takeTurn((work) => rateLimiter.schedule(work));
}
