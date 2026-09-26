import chalk from 'chalk';
import { existsSync, statSync } from 'node:fs';
import { confirm, editor, select } from '@inquirer/prompts';
import type { Message } from 'ollama';

import { ollama, saveSetting, session } from './config';
import { getLogger } from './logging';
import { cycleMode } from './approval';
import { modelContextLength, preflight } from './preflight';
import { beginTurn, changes, countSince, rewind } from './checkpoints';
import { ensureTokenizer } from './tokenizer';
import {
  applyEntry,
  chooseEntry,
  findEntry,
  loadStore,
  rememberEntry,
  saveStore
} from './models';
import {
  append,
  listSessions,
  loadSession,
  rewrite,
  startSession
} from './session';
import { takeYield } from './turn';
import type { makeThinker } from './ollama';
import { readFile } from '../tools/read';
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
  ContextLimit: 'context-limit',
  Mode: 'mode',
  Model: 'model',
  Compact: 'compact',
  Recap: 'recap',
  Paste: 'paste',
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
  | 'think'
  | 'load'
  | 'reset'
  | 'rebuild'
  | 'compact'
  | 'recap'
  | 'tokens'
  | 'turnCount'
>;

// how a turn gets to run - the command hands in its rate limiter, and a test
// runs the work directly
type Schedule = (work: () => Promise<ThoughtState>) => Promise<ThoughtState>;

type ControllerOptions = {
  thinker: Thinker;
  // the context size past which the history is compacted after a turn - asked
  // each time, since /context-limit can move it mid-session
  compactAt: () => number;
  // handed everything the user typed in a session that was just restored, so
  // the prompt they type into next can offer it back. the prompt itself is the
  // caller's business - this module never touches it
  rememberPrompts?: (prompts: string[]) => void;
};

// a prompt that mentioned files carries them in its content, but what the user
// typed is what they would recognise and want back
const typedText = ({ content, typed }: AgentMessage) => typed ?? content;

// something the user said, typed or pasted - tool output and the notes
// compaction flags as its own are not prompts
const isUserPrompt = (message: AgentMessage) =>
  message.role === 'user' &&
  Boolean(typedText(message).trim()) &&
  !message.summary;

// what the user typed, oldest first - so the last thing they said is one press
// away. a multi-line one cannot be recalled into readline's single-line buffer
// without corrupting the display, so it is dropped rather than truncated
const isTypedPrompt = (message: AgentMessage) =>
  isUserPrompt(message) && !typedText(message).includes('\n');

// a prompt on one line, for a list or a question that has only one to give it
const oneLine = (message: AgentMessage) =>
  typedText(message).replace(/\s+/g, ' ').trim();

// start-of-text or whitespace before the @, so an email address is left alone
const mentionPattern = /(?:^|\s)@(\S+)/g;
const trailingPunctuation = /[.,;:!?)\]}'"]+$/;

// each file mentioned with @ is attached below the prompt as the read tool
// would have returned it, numbered and cut to the same budget, so the model
// gets the contents without spending a round asking for them. anything that
// is not a file is left as the text it was typed as
const expandMentions = (content: string) => {
  const isFile = (path: string) => existsSync(path) && statSync(path).isFile();
  const paths = new Set<string>();

  for (const [, mention] of content.matchAll(mentionPattern)) {
    // a mention ending a clause picks up its punctuation, which is only part
    // of the path if a file by that name really exists
    const path = isFile(mention)
      ? mention
      : mention.replace(trailingPunctuation, '');

    if (isFile(path)) {
      paths.add(path);
    }
  }

  const attached = [...paths].map(
    (path) => `Contents of ${path}:\n${readFile({ path })}`
  );

  return attached.length ? [content, ...attached].join('\n\n') : undefined;
};

const typedPrompts = (messages: AgentMessage[]) => {
  const prompts = messages.filter(isTypedPrompt).map(typedText);
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
  // whether the last turn ended in an error rather than a response - the
  // interactive loop just carries on, but a headless run reports it on exit
  let failed = false;

  // set when compaction runs but cannot free anything, so the automatic trigger
  // below stops paying for a summarization call every single turn. asking for
  // /compact by hand clears it, as does dropping the history outright
  let compactionStalled = false;

  // the turn each prompt typed here started, for /undo. a prompt restored from
  // a session file has none, since its changes were made by another process
  const turns = new WeakMap<Message, number>();
  // what the next prompt should start out holding - the prompt /undo took back,
  // so it can be edited and sent again
  let prefill: string | undefined;

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

    log.info(
      chalk.green(
        `Resumed ${messages.length} message(s) using ${thinker.tokens.messages} tokens`
      )
    );

    const lastResponse = messages.findLast(
      (message) => message.role === 'assistant'
    );

    // print out last response to establish context with user
    if (lastResponse) {
      log.info(
        lastResponse.thinking
          ? chalk.blue(lastResponse.thinking)
          : chalk.gray(lastResponse.content)
      );
    }

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
    const { measured, messages, skills, system, tools, total } = thinker.tokens;
    const share = Math.round((total / ollama.contextLimit) * 100);
    const estimated = chalk.gray('(estimated)');

    // the parts are always the tokenizer's estimate, while the total is
    // ollama's own count of the last prompt once there has been one - so they
    // deliberately do not add up
    console.log(
      `${systemColor('{SYSTEM   }')} - ${system} tokens ${estimated}`
    );
    console.log(
      `${systemColor('{SKILLS   }')} - ${skills} tokens ${estimated}`
    );
    console.log(`${systemColor('{TOOLS    }')} - ${tools} tokens ${estimated}`);
    console.log(
      `${systemColor('{MESSAGES }')} - ${messages} tokens ${estimated}`
    );
    console.log(
      `${systemColor('{TOTAL    }')} - ${total} tokens / ${ollama.contextLimit} max (${share}%) ${
        measured ? chalk.gray('(counted by ollama)') : estimated
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
            name: `${describeAge(summary.updatedAt).padStart(8)}  ${summary.label} ${chalk.gray(`(${summary.messages} messages)`)}`,
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

  // takes the conversation back to just before one of the user's prompts, and
  // every file written since along with it - so the model is never left
  // believing in edits that are no longer there
  const undoTurn = async () => {
    const { messages } = nextThought;
    const prompts = [...messages.entries()].filter(([, message]) =>
      isUserPrompt(message)
    );

    if (!prompts.length) {
      log.warn(
        systemColor(
          'There is nothing to undo - no prompt has been sent this session.'
        )
      );

      return;
    }

    // restored prompts come before any typed here, so one without a turn of
    // its own is rewound along with the first typed prompt after it. with none
    // after it, nothing this process wrote belongs to it
    const turnFor = (index: number) =>
      messages
        .slice(index)
        .map((message) => turns.get(message))
        .find((turn) => turn !== undefined) ?? Infinity;

    try {
      const index = await select({
        message: 'Undo back to before which prompt?',
        choices: prompts.reverse().map(([index, message]) => {
          const content = oneLine(message);
          const label =
            content.length > 60 ? `${content.slice(0, 60)}…` : content;

          return {
            name: `${label} ${chalk.gray(`(${countSince(turnFor(index))} file change(s))`)}`,
            value: index
          };
        })
      });
      const prompt = messages[index];
      const files = countSince(turnFor(index));
      const dropped = messages.length - index;

      if (
        !(await confirm({
          message: `Undo "${oneLine(prompt)}"? This reverts ${files} file change(s) and drops ${dropped} message(s). Anything done by shell commands is not reversed.`,
          default: false
        }))
      ) {
        return;
      }

      const { restored, failed } = rewind(turnFor(index));

      restored.forEach((line) => console.log(systemColor(line)));

      // the conversation only goes back once the files have, or the model
      // would be told edits are gone that are in fact still there
      if (failed) {
        log.error(chalk.red(`${failed} - the conversation was left as it was`));

        return;
      }

      nextThought = { messages: messages.slice(0, index) };
      needsUserInput = true;
      compactionStalled = false;
      thinker.load(nextThought.messages);
      rewrite(nextThought.messages);
      // a pasted prompt would corrupt the single-line prompt it was put back
      // into, so it is only offered back when it fits there
      prefill = isTypedPrompt(prompt) ? typedText(prompt) : undefined;

      log.info(
        chalk.green(
          `Undid ${dropped} message(s) and ${restored.length} file change(s)`
        )
      );
    } catch (error) {
      // log but swallow an error (if the user cancelled the prompt)
      if (error instanceof Error) {
        log.error(error.message);
      }
    }
  };

  // switching mid-conversation rather than at startup: the history is kept and
  // handed to the thinker to be counted again, since the tokenizer that
  // measured it belonged to the model being left behind
  const switchModel = async () => {
    const previous = findEntry(loadStore(), ollama.model);
    const entry = await chooseEntry();

    if (!entry) {
      return;
    }

    if (entry.model === ollama.model) {
      log.info(systemColor(`Already using ${entry.model}`));

      return;
    }

    rememberEntry(entry);
    applyEntry(entry);

    // the same checks a startup gets: a model that is not installed, or one
    // that cannot call tools, is worth hearing about before the next turn
    if (!(await preflight())) {
      if (previous) {
        applyEntry(previous);
        // the store said this entry was the one to start on, and a switch that
        // did not happen must not change that
        saveStore({ ...loadStore(), active: previous.model });
        log.warn(chalk.red(`Staying on ${previous.model}`));
      }

      return;
    }

    await ensureTokenizer();
    thinker.rebuild(nextThought.messages);

    log.info(
      chalk.green(
        `Switched to ${entry.model} using the ${entry.tokenizer} tokenizer - ${thinker.tokens.total} tokens`
      )
    );
  };

  // shows the limit, or changes it and saves it to config.yml for the runs
  // that follow. every reader of ollama.contextLimit asks at call time, so
  // assigning it is enough for this session
  const contextLimit = async (value?: string) => {
    const supported = modelContextLength();

    if (value === undefined) {
      console.log(
        systemColor(
          `Context limit is ${ollama.contextLimit} tokens${
            supported ? ` (${ollama.model} supports ${supported})` : ''
          }`
        )
      );

      return;
    }

    const limit = /^\d+$/.test(value) ? parseInt(value, 10) : NaN;

    if (!(limit > 0)) {
      log.error(
        chalk.red(
          'Expected a positive number of tokens, e.g. /context-limit 32768'
        )
      );

      return;
    }

    ollama.contextLimit = limit;
    log.info(chalk.green(`Context limit set to ${limit} tokens`));

    try {
      saveSetting('ollama', 'contextLimit', limit);
    } catch (error) {
      log.warn(
        chalk.red(
          `Could not save the context limit to config.yml - ${describeError(error)}`
        )
      );
    }

    if (supported && limit > supported) {
      log.warn(
        chalk.red(
          `${ollama.model} supports ${supported} - the prompt will be silently truncated`
        )
      );
    }

    // a lowered limit can leave the history already past the new threshold,
    // and the next turn would go out with a num_ctx too small to hold it
    if (thinker.tokens.total > compactAt()) {
      compactionStalled = false;
      await compact();
    }
  };

  // a prompt longer than one line, written in the user's own editor since the
  // command prompt cannot hold one. sent as though it had been typed, so the
  // loop goes straight on to the turn instead of asking again
  const paste = async () => {
    try {
      const text = await editor({
        message: 'Compose a prompt',
        postfix: '.md',
        waitForUserInput: false
      });

      if (!text.trim()) {
        log.warn(systemColor('Nothing was pasted'));

        return;
      }

      addUserMessage(text);
    } catch (error) {
      // log but swallow an error (if the editor could not be opened)
      if (error instanceof Error) {
        log.error(error.message);
      }
    }
  };

  // what the last few turns were about, only when asked for since it costs a
  // model call. printed and nothing more - it goes into neither the
  // conversation, the session file nor the prompt history, so it can never be
  // mistaken for something the user said or be sent back to the model
  const recap = async (value?: string) => {
    const count =
      value === undefined
        ? session.recapTurns
        : /^\d+$/.test(value)
          ? parseInt(value, 10)
          : NaN;

    if (value !== undefined && !(count > 0)) {
      log.error(
        chalk.red('Expected a positive number of turns, e.g. /recap 5')
      );

      return;
    }

    if (!nextThought.messages.length) {
      log.warn(systemColor('There is nothing to recap yet'));

      return;
    }

    const text = await thinker.recap(nextThought.messages, count);

    if (text) {
      log.info(chalk.blue(text));
    }
  };

  // a slash command, without its slash, and anything typed after its name.
  // quitting is left to the caller, which owns the process and what has to be
  // cleaned up before it exits
  const runCommand = async (input: string) => {
    const [name, ...args] = input.trim().split(/\s+/);

    switch (name) {
      case Command.Context:
        showContext();
        break;
      case Command.ContextLimit:
        await contextLimit(args[0]);
        break;
      case Command.Mode:
        cycleMode();
        break;
      case Command.Model:
        await switchModel();
        break;
      case Command.Compact:
        // an explicit request overrides an earlier stalled attempt
        compactionStalled = false;
        await compact();
        break;
      case Command.Recap:
        await recap(args[0]);
        break;
      case Command.Paste:
        await paste();
        break;
      case Command.Clear:
      case Command.Reset:
        clear();
        break;
      case Command.Resume:
        await chooseSession();
        break;
      case Command.Undo:
        await undoTurn();
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
    const expanded = expandMentions(content);
    const message: AgentMessage = expanded
      ? { role: 'user', content: expanded, typed: content }
      : { role: 'user', content };

    nextThought.messages.push(message);
    turns.set(message, beginTurn());

    needsUserInput = false;
  };

  const takeTurn = async (schedule: Schedule = (work) => work()) => {
    failed = false;

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
      failed = true;
    }

    // written after the turn rather than as it happens, so a crash costs at
    // most the round that caused it. a failed call leaves the user's message
    // here to be picked up by the next one
    append(nextThought.messages);

    if (nextThought.interrupted) {
      nextThought.interrupted = false;
      needsUserInput = true;
    } else if (!compactionStalled && thinker.tokens.total > compactAt()) {
      await compact();
    }
  };

  // the whole of a non-interactive run: one prompt, then as many rounds as the
  // model wants until it hands the conversation back. true unless the model
  // call itself failed
  const runPrompt = async (prompt: string, schedule?: Schedule) => {
    addUserMessage(prompt);

    do {
      await takeTurn(schedule);
    } while (!needsUserInput);

    return !failed;
  };

  return {
    restore,
    compact,
    clear,
    runCommand,
    addUserMessage,
    takeTurn,
    runPrompt,
    // handed out once, so the prompt after that one starts empty again
    takePrefill() {
      const taken = prefill;

      prefill = undefined;

      return taken;
    },
    get messages() {
      return nextThought.messages;
    },
    get needsUserInput() {
      return needsUserInput;
    },
    get compactionStalled() {
      return compactionStalled;
    },
    get failed() {
      return failed;
    }
  };
};
