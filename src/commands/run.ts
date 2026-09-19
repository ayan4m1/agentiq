import chalk from 'chalk';
import inquirer from 'inquirer';
import Bottleneck from 'bottleneck';
import { program } from 'commander';
import { select } from '@inquirer/prompts';
import InquirerCommandPrompt, { type KeyEvent } from 'inquirer-command-prompt';

import { ollama } from '../modules/config';
import { killAllJobs } from '../modules/jobs';
import { changes, discardCheckpoints, undo } from '../modules/checkpoints';
import { getLogger } from '../modules/logging';
import { compactThreshold, makeThinker } from '../modules/ollama';
import { preflight } from '../modules/preflight';
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
import type { ThoughtState } from '../types';
import { describeAge, describeError, getTokenString } from '../utils';

const log = getLogger('run');
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

// the switch below and the /help listing both read from here, so a new
// command only has to be added in one place
const Command = {
  Context: 'context',
  Mode: 'mode',
  Compact: 'compact',
  Clear: 'clear',
  Reset: 'reset',
  Resume: 'resume',
  Undo: 'undo',
  Changes: 'changes',
  Help: 'help',
  Quit: 'quit'
} as const;

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
        case Command.Context: {
          const { measured, messages, system, tools, total } = thinker.tokens;
          const share = Math.round((total / ollama.contextLimit) * 100);
          const estimated = chalk.dim('(estimated)');

          // the three parts are always the tokenizer's estimate, while the
          // total is ollama's own count of the last prompt once there has been
          // one - so they deliberately do not add up
          console.log(
            `${systemColor('{SYSTEM   }')} - ${system} tokens ${estimated}`
          );
          console.log(
            `${systemColor('{TOOLS    }')} - ${tools} tokens ${estimated}`
          );
          console.log(
            `${systemColor('{MESSAGES }')} - ${messages} tokens ${estimated}`
          );
          console.log(
            `${systemColor('{TOTAL    }')} - ${total} tokens / ${ollama.contextLimit} max (${share}%) ${
              measured ? chalk.dim('(counted by ollama)') : estimated
            }`
          );
          break;
        }
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
        case Command.Undo:
          // the model is told nothing about this: the file going back to what
          // it was is the user's business, and a note in the transcript would
          // only invite it to put the change back
          console.log(systemColor(undo()));
          break;
        case Command.Changes:
          console.log(systemColor(changes()));
          break;
        case Command.Help:
          console.log(systemColor('\n--- Available Commands ---'));
          Object.values(Command).forEach((cmd) =>
            console.log(`${systemColor('*')} /${cmd}`)
          );
          console.log(systemColor('---------------------------\n'));
          break;
        case Command.Quit:
          cleanUp();
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
