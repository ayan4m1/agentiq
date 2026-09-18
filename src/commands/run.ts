import chalk from 'chalk';
import inquirer from 'inquirer';
import Bottleneck from 'bottleneck';
import { program } from 'commander';
import { select } from '@inquirer/prompts';
import InquirerCommandPrompt, { KeyEvent } from 'inquirer-command-prompt';

import { ollama } from '../modules/config';
import { killAllJobs } from '../modules/jobs';
import { getLogger } from '../modules/logging';
import { makeThinker } from '../modules/ollama';
import { ensureTokenizer } from '../modules/tokenizer';
import { cycleMode, describeMode } from '../modules/approval';
import {
  append,
  listSessions,
  loadSession,
  pruneSessions,
  rewrite,
  startSession
} from '../modules/session';
import { takeYield } from '../modules/turn';
import { ThoughtState } from '../types';
import { describeAge, describeError, getTokenString } from '../utils';

const log = getLogger('run');
// compacting on the way to the limit rather than at it leaves room for the
// summarization call itself, which still has to fit in the same window
const compactThreshold = 0.8;
const systemColor = chalk.yellow;

// commander runs this file as its own executable, so the options it was given
// arrive here rather than in src/index.ts - the supported spelling is
// `agentiq run --resume`, since the parent program owns the bare argv
const { resume } = program
  .allowUnknownOption()
  .allowExcessArguments()
  .option('--resume [id]', 'resume the most recent session, or one by id')
  .parse(process.argv)
  .opts();

// makeThinker() tokenizes the system prompt and every tool definition up front,
// so the tokenizer has to be on disk before it runs
await ensureTokenizer();

const thinker = makeThinker();
const rateLimiter = new Bottleneck({
  maxConcurrent: 1,
  minTime: 1000
});

// a dev server that outlives the session holds its port and is only noticed
// much later, so every way out of here goes through killAllJobs first
process.on('exit', killAllJobs);
// ^C during generation is raised as a signal by modules/interrupt.ts, and
// listening for it replaces the default termination - so exit deliberately
process.on('SIGINT', () => {
  killAllJobs();
  process.exit(130);
});

// the switch below and the /help listing both read from here, so a new
// command only has to be added in one place
enum Command {
  Context = 'context',
  Mode = 'mode',
  Compact = 'compact',
  Clear = 'clear',
  Reset = 'reset',
  Resume = 'resume',
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

// loading an earlier conversation also hands the session file back to it, so
// the resumed history keeps growing where it left off
const restore = (id?: string) => {
  const target = id ?? listSessions(1)[0]?.id;

  if (!target) {
    log.warn(chalk.red('There are no saved sessions to resume'));

    return false;
  }

  const messages = loadSession(target);

  if (!messages) {
    log.error(chalk.red(`There is no session called ${target}`));

    return false;
  }

  nextThought = { messages };
  needsUserInput = true;
  compactionStalled = false;
  thinker.load(messages);

  log.info(
    chalk.green(
      `Resumed ${messages.length} message(s) using ${thinker.tokens.messages} tokens`
    )
  );

  return true;
};

pruneSessions();

// a failed resume still needs somewhere to write what happens next
if (!resume || !restore(typeof resume === 'string' ? resume : undefined)) {
  startSession();
}

// the share has to be measured against what the context held beforehand -
// reading thinker.tokens.total afterwards divides by the already-shrunken
// total and reports well over 100%
const logFreed = (freed: number, before: number) =>
  log.info(
    chalk.green(
      `Freed ${freed} tokens from context (${Math.round((freed / before) * 100)}%)`
    )
  );

const compact = async () => {
  const before = thinker.tokens.total;
  const { messages, freed } = await thinker.compact(nextThought.messages);

  nextThought.messages = messages;
  compactionStalled = freed <= 0;
  // summarizing replaces the messages outright, so there is nothing left to
  // append to - the file has to be written again from what survived
  rewrite(messages);

  if (compactionStalled) {
    log.warn(
      chalk.red('Could not compact any further - use /clear to start over')
    );
  } else {
    logFreed(freed, before);
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
          // a new file rather than an emptied one - starting over should not
          // destroy the conversation being walked away from
          startSession();
          const before = thinker.tokens.total;

          logFreed(thinker.reset(), before);
          break;
        }
        case Command.Resume: {
          const summaries = listSessions();

          if (!summaries.length) {
            restore();
            break;
          }

          try {
            restore(
              await select({
                message: 'Which session?',
                choices: summaries.map((summary) => ({
                  name: `${describeAge(summary.updatedAt).padStart(8)}  ${summary.label} ${chalk.dim(`(${summary.messages} messages)`)}`,
                  value: summary.id
                }))
              })
            );
          } catch (error) {
            // log but swallow an error (if the user cancelled the prompt)
            if (error instanceof Error) {
              log.error(error.message);
            }
          }

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
          killAllJobs();
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

  // written after the turn rather than as it happens, so a crash costs at most
  // the round that caused it. a failed call leaves the user's message here to
  // be picked up by the next one
  append(nextThought.messages);

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
