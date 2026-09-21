import chalk from 'chalk';
import inquirer from 'inquirer';
import { program } from 'commander';
import InquirerCommandPrompt, { type KeyEvent } from 'inquirer-command-prompt';

import { ollama } from '../modules/config';
import { startAgent } from '../modules/startup';
import { compactThreshold } from '../modules/ollama';
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

const agent = await startAgent();

if (!agent) {
  process.exit(1);
}

const { thinker, schedule, cleanUp } = agent;

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

// the library files history under a context key, and gives no way to move its
// cursor back - so a resume starts a fresh key rather than emptying the old
// one, which would leave the up arrow pointing off the end of it
let historyGeneration = 0;
let historyContext = `history-${historyGeneration}`;

const controller = createController({
  thinker,
  compactAt: ollama.contextLimit * compactThreshold,
  rememberPrompts: (prompts) => {
    historyContext = `history-${++historyGeneration}`;
    prompts.forEach((prompt) =>
      InquirerCommandPrompt.addToHistory(historyContext, prompt)
    );
  }
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
    //@ts-expect-error inquirer has a context of its own that means something
    // else entirely, so its type rejects the history key the command prompt
    // reads from here
    const { userMessage } = await inquirer.prompt({
      type: 'command',
      name: 'userMessage',
      message: renderPrompt(),
      context: historyContext
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

  await controller.takeTurn(schedule);
}
