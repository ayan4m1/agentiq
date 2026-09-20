import chalk from 'chalk';
import { select } from '@inquirer/prompts';

import { ollama, session } from './config';
import { getLogger } from './logging';
import { cycleMode } from './approval';
import { changes, undo } from './checkpoints';
import {
  append,
  listSessions,
  loadSession,
  rewrite,
  startSession
} from './session';
import { takeYield } from './turn';
import type { makeThinker } from './ollama';
import type { AgentMessage, ThoughtState } from '../types';
import { describeAge, describeError } from '../utils';

// the label stays that of the command it was lifted out of, so the log reads
// the same as it always has
const log = getLogger('run');

export const systemColor = chalk.yellow;

// the switch below and the /help listing both read from here, so a new
// command only has to be added in one place
export const Command = {
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

type Thinker = Pick<
  ReturnType<typeof makeThinker>,
  'think' | 'load' | 'reset' | 'compact' | 'tokens' | 'turnCount'
>;

// how a turn gets to run - the command hands in its rate limiter, and a test
// runs the work directly
type Schedule = (work: () => Promise<ThoughtState>) => Promise<ThoughtState>;

type ControllerOptions = {
  thinker: Thinker;
  // the context size past which the history is compacted after a turn
  compactAt: number;
  // handed everything the user typed in a session that was just restored, so
  // the prompt they type into next can offer it back. the prompt itself is the
  // caller's business - this module never touches it
  rememberPrompts?: (prompts: string[]) => void;
};

// what the user typed, oldest first - so the last thing they said is one press
// away. tool output and the notes compaction flags as its own are not prompts,
// and a multi-line one cannot be recalled into readline's single-line buffer
// without corrupting the display, so it is dropped rather than truncated
const typedPrompts = (messages: AgentMessage[]) => {
  const prompts = messages
    .filter(
      ({ role, content, summary }) =>
        role === 'user' && content.trim() && !summary && !content.includes('\n')
    )
    .map(({ content }) => content);
  const { historyLimit } = session;

  return Number.isFinite(historyLimit) && historyLimit > 0
    ? prompts.slice(-historyLimit)
    : prompts;
};

// everything the run loop keeps between turns, and everything it does to it -
// the loop itself is only the prompt, and the prompt cannot be tested
export const createController = ({
  thinker,
  compactAt,
  rememberPrompts
}: ControllerOptions) => {
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
    rememberPrompts?.(typedPrompts(messages));

    const lastResponse = messages.findLast(
      (message) => message.role === 'assistant'
    );

    // print out last response to establish context with user
    if (lastResponse) {
      log.info(
        lastResponse.thinking
          ? chalk.blue(lastResponse.thinking)
          : chalk.dim(lastResponse.content)
      );
    }

    log.info(
      chalk.green(
        `Resumed ${messages.length} message(s) using ${thinker.tokens.messages} tokens`
      )
    );

    return true;
  };

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

  const clear = () => {
    nextThought.lastResponse = undefined;
    nextThought.messages = [];
    compactionStalled = false;
    // a new file rather than an emptied one - starting over should not
    // destroy the conversation being walked away from
    startSession();
    const before = thinker.tokens.total;

    logFreed(thinker.reset(), before);
  };

  const showContext = () => {
    const { measured, messages, system, tools, total } = thinker.tokens;
    const share = Math.round((total / ollama.contextLimit) * 100);
    const estimated = chalk.dim('(estimated)');

    // the three parts are always the tokenizer's estimate, while the total is
    // ollama's own count of the last prompt once there has been one - so they
    // deliberately do not add up
    console.log(
      `${systemColor('{SYSTEM   }')} - ${system} tokens ${estimated}`
    );
    console.log(`${systemColor('{TOOLS    }')} - ${tools} tokens ${estimated}`);
    console.log(
      `${systemColor('{MESSAGES }')} - ${messages} tokens ${estimated}`
    );
    console.log(
      `${systemColor('{TOTAL    }')} - ${total} tokens / ${ollama.contextLimit} max (${share}%) ${
        measured ? chalk.dim('(counted by ollama)') : estimated
      }`
    );
  };

  const chooseSession = async () => {
    const summaries = listSessions();

    if (!summaries.length) {
      restore();

      return;
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
  };

  // a slash command, named without its slash. quitting is left to the caller,
  // which owns the process and what has to be cleaned up before it exits
  const runCommand = async (name: string) => {
    switch (name) {
      case Command.Context:
        showContext();
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
      case Command.Reset:
        clear();
        break;
      case Command.Resume:
        await chooseSession();
        break;
      case Command.Undo:
        // the model is told nothing about this: the file going back to what it
        // was is the user's business, and a note in the transcript would only
        // invite it to put the change back
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
        return Command.Quit;
      default:
        log.error(chalk.red(`Tried to use unknown command /${name}!`));
        break;
    }

    return undefined;
  };

  const addUserMessage = (content: string) => {
    nextThought.messages.push({
      role: 'user',
      content
    });

    needsUserInput = false;
  };

  const takeTurn = async (schedule: Schedule = (work) => work()) => {
    try {
      nextThought = await schedule(async () => {
        const result = await thinker.think(nextThought);

        log.debug(
          `Round ${thinker.turnCount} - ${thinker.tokens.total} tokens`
        );

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
      // one bad response should cost the turn, not the conversation - the
      // history is still intact, so hand control back and let the user retry
      log.error(chalk.red(`The model call failed: ${describeError(error)}`));

      needsUserInput = true;
    }

    // written after the turn rather than as it happens, so a crash costs at
    // most the round that caused it. a failed call leaves the user's message
    // here to be picked up by the next one
    append(nextThought.messages);

    if (nextThought.interrupted) {
      nextThought.interrupted = false;
      needsUserInput = true;
    } else if (!compactionStalled && thinker.tokens.total > compactAt) {
      await compact();
    }
  };

  return {
    restore,
    compact,
    clear,
    runCommand,
    addUserMessage,
    takeTurn,
    get messages() {
      return nextThought.messages;
    },
    get needsUserInput() {
      return needsUserInput;
    },
    get compactionStalled() {
      return compactionStalled;
    }
  };
};
