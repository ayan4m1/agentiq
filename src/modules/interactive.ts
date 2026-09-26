import chalk from 'chalk';
import inquirer from 'inquirer';
import InquirerCommandPrompt, { type KeyEvent } from 'inquirer-command-prompt';

import { ollama } from './config';
import { startAgent } from './startup';
import { compactThreshold } from './ollama';
import { cycleMode, describeMode } from './approval';
import { pruneSessions, startSession } from './session';
import { Command, createController, systemColor } from './repl';
import { getTokenString } from '../utils';

type ReplOptions = {
  // true for the most recent session, or the id of one
  resume?: string | boolean;
};

// the interactive session commands/run.ts starts - kept apart from it so that a
// test can start one as often as it likes, where the command can only be run
export const startRepl = async ({ resume }: ReplOptions): Promise<never> => {
  const agent = await startAgent();

  if (!agent) {
    process.exit(1);
  }

  const { thinker, schedule, cleanUp } = agent;

  const renderPrompt = () =>
    `${systemColor(`${describeMode()}${getTokenString(thinker.tokens.messages)}`)}\n${chalk.blue('>')}`;

  // the prompt's own tab branch has no shift guard, so shift+tab would otherwise
  // fall into autocompletion and leave a literal tab in the buffer
  class ModeCommandPrompt extends InquirerCommandPrompt {
    // written in as if typed, once the prompt is listening - so it is shown,
    // editable, with the cursor at its end. readline takes it straight into
    // the line without a keypress, so nothing would redraw it otherwise
    run() {
      const answer = super.run();

      if (this.opt.prefill) {
        this.rl.write(this.opt.prefill);
        this.render();
      }

      return answer;
    }

    async onKeypress(event: KeyEvent) {
      if (event?.key?.name !== 'tab' || !event.key.shift) {
        return super.onKeypress(event);
      }

      // the banner cycleMode prints would otherwise land on the input line, and
      // the redraw below would only erase part of what is on screen
      this.rl.output.unmute();
      this.screen.clean(this.screen.extraLinesUnderPrompt);
      this.screen.height = 0;
      this.screen.extraLinesUnderPrompt = 0;

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
    compactAt: () => ollama.contextLimit * compactThreshold,
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
    !(await controller.restore(typeof resume === 'string' ? resume : undefined))
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
        context: historyContext,
        prefill: controller.takePrefill()
      });

      if (userMessage.startsWith('/')) {
        if (
          (await controller.runCommand(userMessage.substring(1))) ===
          Command.Quit
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
};
