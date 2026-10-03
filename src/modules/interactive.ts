import chalk from 'chalk';
import inquirer from 'inquirer';
import InquirerCommandPrompt, { type KeyEvent } from 'inquirer-command-prompt';

import { provider } from './config';
import { startAgent } from './startup';
import { compactThreshold } from './thinker';
import { cycleMode, describeMode } from './approval';
import { describeCheck } from './check';
import { pruneSessions, sessionId, startSession } from './session';
import { complete, createPathIndex, shortCompletions } from './completion';
import { Command, createController, systemColor } from './repl';
import { getTokenString } from '../utils';
import { getLogger } from './logging';

type ReplOptions = {
  // true for the most recent session, or the id of one
  resume?: string | boolean;
};

const log = getLogger('interactive');

// the interactive session commands/run.ts starts - kept apart from it so that a
// test can start one as often as it likes, where the command can only be run
export const startRepl = async ({ resume }: ReplOptions): Promise<never> => {
  const agent = await startAgent();

  if (!agent) {
    process.exit(1);
  }

  const { thinker, schedule, cleanUp } = agent;

  const renderPrompt = () =>
    `${systemColor(`${describeMode()}${getTokenString(thinker.tokens.total)}${describeCheck()}`)}\n${chalk.blue('>')}`;

  // the prompt's own tab branch has no shift guard, so shift+tab would otherwise
  // fall into autocompletion and leave a literal tab in the buffer
  class ModeCommandPrompt extends InquirerCommandPrompt {
    // the library prints a completion list under the prompt and then redraws,
    // and the redraw erases as many lines as the two-line prompt last took -
    // the list's last row, or all of a list short enough to fit on one
    private listed = false;

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

    render() {
      // so the redraw starts below the list instead of over it
      if (this.listed) {
        this.listed = false;
        this.screen.height = 0;
        this.screen.extraLinesUnderPrompt = 0;
      }

      return super.render();
    }

    async onKeypress(event: KeyEvent) {
      if (event?.key?.name !== 'tab') {
        return super.onKeypress(event);
      }

      if (!event.key.shift) {
        // short is only asked for when a list is about to be printed
        const { short } = this.opt;

        if (short) {
          this.opt.short = (line, matches) => {
            this.listed = true;

            return short(line, matches);
          };
        }

        try {
          return await super.onKeypress(event);
        } finally {
          this.opt.short = short;
        }
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
    compactAt: () => provider.contextLimit * compactThreshold,
    rememberPrompts: (prompts) => {
      historyContext = `history-${++historyGeneration}`;
      prompts.forEach((prompt) =>
        InquirerCommandPrompt.addToHistory(historyContext, prompt)
      );
    },
    rememberPrompt: (line) =>
      InquirerCommandPrompt.addToHistory(historyContext, line)
  });

  const commands = Object.values(Command);
  const paths = createPathIndex();

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
      // whatever the last turn wrote or deleted should be offered, or not
      paths.invalidate();

      //@ts-expect-error inquirer has a context of its own that means something
      // else entirely, so its type rejects the history key the command prompt
      // reads from here
      const { userMessage } = await inquirer.prompt({
        type: 'command',
        name: 'userMessage',
        message: renderPrompt(),
        context: historyContext,
        prefill: controller.takePrefill(),
        autoCompletion: (line: string) => complete(line, { commands, paths }),
        short: shortCompletions,
        // the library's own heading says commands, which a path list is not
        autocompletePrompt: systemColor('Completions:')
      });

      // nothing typed, or only whitespace - there is nothing to send, so ask
      // again rather than spending a turn on an empty message
      if (!userMessage.trim()) {
        continue;
      }

      // a multi-line prompt recalled from the history, which only ever holds
      // its preview - the editor it opens in sends it on from there
      if (await controller.reopenPaste(userMessage)) {
        continue;
      }

      if (userMessage.startsWith('/')) {
        if (
          (await controller.runCommand(userMessage.substring(1))) ===
          Command.Quit
        ) {
          cleanUp();
          if (controller.messages.length) {
            log.info(
              chalk.gray(
                `Resume this session with: agentiq --resume ${sessionId()}`
              )
            );
          }
          process.exit(0);
        }

        continue;
      }

      controller.addUserMessage(userMessage);
    }

    await controller.takeTurn(schedule);
  }
};
