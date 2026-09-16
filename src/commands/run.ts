import chalk from 'chalk';
import inquirer from 'inquirer';
import Bottleneck from 'bottleneck';
import InquirerCommandPrompt, { KeyEvent } from 'inquirer-command-prompt';

import { ollama } from '../modules/config';
import { getLogger } from '../modules/logging';
import { makeThinker } from '../modules/ollama';
import { cycleMode, describeMode } from '../modules/approval';
import { takeYield } from '../modules/turn';
import { ThoughtState } from '../types';
import { describeError, getTokenString } from '../utils';

const log = getLogger('run');
// compacting on the way to the limit rather than at it leaves room for the
// summarization call itself, which still has to fit in the same window
const compactThreshold = 0.8;
const systemColor = chalk.yellow;
const thinker = makeThinker();
const rateLimiter = new Bottleneck({
  maxConcurrent: 1,
  minTime: 1000
});

// the switch below and the /help listing both read from here, so a new
// command only has to be added in one place
enum Command {
  Context = 'context',
  Mode = 'mode',
  Compact = 'compact',
  Clear = 'clear',
  Reset = 'reset',
  Help = 'help',
  Quit = 'quit'
}

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

let nextThought: ThoughtState = {
  messages: []
};
let needsUserInput = true;

// set when compaction runs but cannot free anything, so the automatic trigger
// below stops paying for a summarization call every single turn. asking for
// /compact by hand clears it, as does dropping the history outright
let compactionStalled = false;

const compact = async () => {
  const { messages, freed } = await thinker.compact(nextThought.messages);

  nextThought.messages = messages;
  compactionStalled = freed <= 0;

  if (compactionStalled) {
    log.warn(
      chalk.red('Could not compact any further - use /clear to start over')
    );
  } else {
    log.info(
      chalk.bgGreen(
        `Freed ${freed} tokens from context (${Math.round((freed / thinker.tokens.total) * 100)}%)`
      )
    );
  }
};

while (true) {
  if (needsUserInput) {
    //@ts-expect-error saveHistory must be a bool but inquirer doesn't allow that
    const { userMessage } = await inquirer.prompt({
      type: 'command',
      name: 'userMessage',
      message: renderPrompt(),
      saveHistory: true
    });

    if (userMessage.startsWith('/')) {
      switch (userMessage.substring(1)) {
        case Command.Context:
          // system prompt
          console.log(
            `${systemColor('{SYSTEM   }')} - ${thinker.tokens.system} tokens`
          );
          // tool definitions
          console.log(
            `${systemColor('{TOOLS    }')} - ${thinker.tokens.tools} tokens`
          );
          console.log(
            `${systemColor('{MESSAGES }')} - ${thinker.tokens.messages} tokens`
          );
          console.log(
            `${systemColor('{TOTAL    }')} - ${thinker.tokens.total} tokens / ${ollama.contextLimit} max (${Math.round((thinker.tokens.total / ollama.contextLimit) * 100)}%)`
          );
          break;
        case Command.Mode:
          cycleMode();
          break;
        case Command.Compact:
          // an explicit request overrides an earlier stalled attempt
          compactionStalled = false;
          await compact();
          break;
        case Command.Clear:
        case Command.Reset: {
          nextThought.lastResponse = undefined;
          nextThought.messages = [];
          compactionStalled = false;
          const total = thinker.tokens.total;
          const freed = thinker.reset();

          log.info(
            chalk.bgGreen(
              `Freed ${freed} tokens from context (${Math.round((freed / total) * 100)})%`
            )
          );
          break;
        }
        case Command.Help:
          console.log(systemColor('\n--- Available Commands ---'));
          Object.values(Command).forEach((cmd) =>
            console.log(`${systemColor('*')} /${cmd}`)
          );
          console.log(systemColor('---------------------------\n'));
          break;
        case Command.Quit:
          process.exit(0);
        // eslint-disable-next-line no-fallthrough
        default:
          log.error(chalk.red(`Tried to use unknown command ${userMessage}!`));
          break;
      }

      continue;
    }

    nextThought.messages.push({
      role: 'user',
      content: userMessage
    });

    needsUserInput = false;
  }

  try {
    nextThought = await rateLimiter.schedule(async () => {
      const result = await thinker.think(nextThought);

      log.debug(`Round ${thinker.turnCount} - ${thinker.tokens.total} tokens`);

      if (result.interrupted) {
        console.log(systemColor('[interrupted]\n'));

        return result;
      }

      // keep thinking while the model is still calling tools - it is only the
      // user's turn again once a round comes back without any, or a tool that
      // already spoke to the user asked for the keyboard back
      needsUserInput =
        takeYield() || !result.lastResponse?.message?.tool_calls?.length;

      return result;
    });
  } catch (error) {
    // one bad response should cost the turn, not the conversation - the history
    // is still intact, so hand control back and let the user retry
    log.error(chalk.red(`The model call failed: ${describeError(error)}`));

    needsUserInput = true;
  }

  if (nextThought.interrupted) {
    nextThought.interrupted = false;
    needsUserInput = true;
  } else if (
    !compactionStalled &&
    thinker.tokens.total > ollama.contextLimit * compactThreshold
  ) {
    await compact();
  }
}
