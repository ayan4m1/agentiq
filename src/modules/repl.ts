import chalk from 'chalk';
import { existsSync, statSync } from 'node:fs';
import { confirm, editor, select } from '@inquirer/prompts';

import { mcp, provider, saveSetting, session } from './config';
import { getLogger } from './logging';
import {
  cycleMode,
  forgetRule,
  loadRules,
  remember,
  type RuleKind
} from './approval';
import { pickModel, pickServers, pickSkills } from './picker';
import { listServers, mcpTools, retryServer, setServerEnabled } from './mcp';
import {
  isEnabled,
  listSkills,
  projectSkillsDir,
  reloadSkills,
  setEnabled,
  skillsDir
} from './skills';
import { expandCommand, loadCommands } from './commands';
import { modelContextLength, preflight, supportsImages } from './preflight';
import {
  clipboardTools,
  isImagePath,
  maxImageBytes,
  readClipboardImage,
  readImage
} from './images';
import { beginTurn, changes, countSince, rewind } from './checkpoints';
import { chatProvider } from '../providers';
import { setMcpTools } from '../tools';
import { ensureTokenizer, usesHfTokenizer } from './tokenizer';
import {
  applyEntry,
  chooseEntry,
  findEntry,
  loadStore,
  markActive,
  rememberEntry
} from './models';
import {
  append,
  listSessions,
  loadSession,
  rewrite,
  sessionCheck,
  startSession
} from './session';
import { beginUserTurn, takeYield } from './turn';
import {
  check,
  diagnosticsMarker,
  fixPrompt,
  restoreCheck,
  runCheck,
  setCheck
} from './check';
import type { makeThinker } from './thinker';
import { readFile } from '../tools/read';
import type {
  AgentMessage,
  ChatMessage,
  ModelEntry,
  ThoughtState
} from '../types';
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
  Image: 'image',
  Clear: 'clear',
  Reset: 'reset',
  Resume: 'resume',
  Undo: 'undo',
  Changes: 'changes',
  Check: 'check',
  Rules: 'rules',
  Skills: 'skills',
  Mcp: 'mcp',
  Help: 'help',
  Quit: 'quit'
} as const;

// the saved prompts that can be sent as /<name>, read fresh each time. a file
// named for a built-in command is left out, since the built-in always runs
export const customCommands = () => loadCommands(Object.values(Command));

type Thinker = Pick<
  ReturnType<typeof makeThinker>,
  | 'think'
  | 'load'
  | 'reset'
  | 'rebuild'
  | 'count'
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
  // handed each prompt sent through the editor, as the line the prompt should
  // offer back for it - the prompt only ever saw the command that opened it
  rememberPrompt?: (line: string) => void;
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

// a multi-line prompt cannot be recalled into readline's single-line buffer
// without corrupting the display, so the history holds this in its place: the
// first line and how much more there is. sending it opens the whole of it in
// the editor again
export const previewOf = (text: string) => {
  const lines = text.trim().split(/\r?\n/);
  const first = lines[0].replace(/\s+/g, ' ').trim();
  const label = first.length > 60 ? `${first.slice(0, 60)}…` : first;
  const more = lines.length - 1;

  return `${label} … (+${more} line${more === 1 ? '' : 's'})`;
};

// a prompt on one line, for a list or a question that has only one to give it
const oneLine = (message: AgentMessage) =>
  typedText(message).replace(/\s+/g, ' ').trim();

// start-of-text or whitespace before the @, so an email address is left alone
const mentionPattern = /(?:^|\s)@(\S+)/g;
const trailingPunctuation = /[.,;:!?)\]}'"]+$/;

// each file mentioned with @ is attached below the prompt as the read tool
// would have returned it, numbered and cut to the same budget, so the model
// gets the contents without spending a round asking for them. an image goes
// along as an image instead, named in the text so the model can tell several
// apart. anything that is not a file is left as the text it was typed as
const attachMentions = (content: string) => {
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

  const texts: string[] = [];
  const images: string[] = [];

  for (const path of paths) {
    if (!isImagePath(path)) {
      texts.push(`Contents of ${path}:\n${readFile({ path })}`);
      continue;
    }

    const read = readImage(path);

    if ('error' in read) {
      log.warn(chalk.red(`Did not attach ${read.error}`));
      continue;
    }

    texts.push(`Attached image: ${path}`);
    images.push(read.image);
  }

  return { texts, images };
};

// the model is still sent the image - the server may know better than what
// it reported, and the user asked for it - but a refusal or a reply that
// ignores it should not come as a surprise
const warnIfBlind = (reason: string) => {
  if (supportsImages() === false) {
    log.warn(
      chalk.red(
        `${provider.model} does not report vision support - ${reason} will likely be ignored or rejected`
      )
    );
  }
};

// everything the run loop keeps between turns, and everything it does to it -
// the loop itself is only the prompt, and the prompt cannot be tested
export const createController = ({
  thinker,
  compactAt,
  rememberPrompts,
  rememberPrompt
}: ControllerOptions) => {
  // the full text behind each preview the history holds. a later prompt with
  // the same preview takes its place, so recalling one gives the newest
  const pasted = new Map<string, string>();

  // the line the command prompt can offer back for a prompt: the prompt itself
  // when it fits on one, or else its preview
  const recallable = (text: string) => {
    if (!text.includes('\n')) {
      return text;
    }

    // the editor leaves a newline at the end of even a single line
    if (!text.trim().includes('\n')) {
      return text.trim();
    }

    const preview = previewOf(text);

    pasted.set(preview, text);

    return preview;
  };

  // what the user said, oldest first - so the last thing they said is one
  // press away
  const typedPrompts = (messages: AgentMessage[]) => {
    const prompts = messages.filter(isUserPrompt);
    const { historyLimit } = session;

    return (
      Number.isFinite(historyLimit) && historyLimit > 0
        ? prompts.slice(-historyLimit)
        : prompts
    ).map((message) => recallable(typedText(message)));
  };

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
  const turns = new WeakMap<ChatMessage, number>();
  // the turn the latest prompt started, and the first turn whose changes the
  // check has not run against yet - a turn that wrote nothing has nothing new
  // to check, but one cut short still leaves its changes for the next
  let currentTurn = 0;
  let checkFrom = 0;
  // what the next prompt should start out holding - the prompt /undo took back,
  // so it can be edited and sent again
  let prefill: string | undefined;
  // images taken from the clipboard by /image, waiting for the prompt that
  // asks about them
  let pendingImages: string[] = [];

  // loading an earlier conversation also hands the session file back to it, so
  // the resumed history keeps growing where it left off
  const restore = async (id?: string) => {
    const target = id ?? listSessions(1)[0]?.id;

    if (!target) {
      log.warn(chalk.red('There are no saved sessions to resume'));

      return false;
    }

    const messages = loadSession(target);

    if (!messages) {
      log.error(chalk.red(`There is no session with ID ${target}`));

      return false;
    }

    nextThought = { messages };
    needsUserInput = true;
    compactionStalled = false;
    thinker.load(messages);
    await thinker.count(messages);
    rememberPrompts?.(typedPrompts(messages));
    restoreCheck(sessionCheck());

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
    // freed stays the estimate both sides of it were measured with - only the
    // total is corrected
    await thinker.count(messages);
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

  const clear = async () => {
    nextThought.lastResponse = undefined;
    nextThought.messages = [];
    compactionStalled = false;
    check.diagnostics = undefined;
    pendingImages = [];
    // a new file rather than an emptied one - starting over should not
    // destroy the conversation being walked away from
    startSession(check.command);
    const before = thinker.tokens.total;

    logFreed(thinker.reset(), before);
    await thinker.count([]);
  };

  const showContext = () => {
    const { mcp, measured, messages, skills, system, tools, total } =
      thinker.tokens;
    const share = Math.round((total / provider.contextLimit) * 100);
    const estimated = chalk.gray('(estimated)');

    // the parts are always the tokenizer's estimate, while the total is the
    // provider's own count of the prompt once there has been one - so they
    // deliberately do not add up
    console.log(
      `${systemColor('{SYSTEM   }')} - ${system} tokens ${estimated}`
    );
    console.log(
      `${systemColor('{SKILLS   }')} - ${skills} tokens ${estimated}`
    );
    console.log(
      `${systemColor('{TOOLS    }')} - ${tools - mcp} tokens ${estimated}`
    );
    console.log(`${systemColor('{MCP      }')} - ${mcp} tokens ${estimated}`);
    console.log(
      `${systemColor('{MESSAGES }')} - ${messages} tokens ${estimated}`
    );
    console.log(
      `${systemColor('{TOTAL    }')} - ${total} tokens / ${provider.contextLimit} max (${share}%) ${
        measured ? chalk.gray(`(counted by ${chatProvider.label})`) : estimated
      }`
    );
  };

  const chooseSession = async () => {
    const summaries = listSessions();

    if (!summaries.length) {
      await restore();

      return;
    }

    try {
      await restore(
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
      pendingImages = [];
      thinker.load(nextThought.messages);
      await thinker.count(nextThought.messages);
      rewrite(nextThought.messages);
      // the failure was in files that have just been put back
      check.diagnostics = undefined;
      // a pasted prompt would corrupt the single-line prompt it was put back
      // into, so it comes back as its preview and is edited in the editor
      prefill = recallable(typedText(prompt));

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
    const previous = findEntry(loadStore(), provider.model);
    const entry = await chooseEntry();

    if (!entry) {
      return;
    }

    if (entry.model === provider.model) {
      log.info(systemColor(`Already using ${entry.model}`));

      return;
    }

    const stayOn = (kept: ModelEntry) => {
      applyEntry(kept);
      // the store said this entry was the one to start on, and a switch that
      // did not happen must not change that
      markActive(kept.model);
      log.warn(chalk.red(`Staying on ${kept.model}`));
    };

    rememberEntry(entry);
    applyEntry(entry);

    // the same checks a startup gets: a model that is not installed, or one
    // that cannot call tools, is worth hearing about before the next turn
    if (!(await preflight())) {
      if (previous) {
        stayOn(previous);
      }

      return;
    }

    if (usesHfTokenizer()) {
      await ensureTokenizer();
    }

    thinker.rebuild(nextThought.messages);
    await thinker.count(nextThought.messages);

    // only now is the session counted by the tokenizer the new model uses. a
    // model that cannot hold what is already here would have ollama drop the
    // oldest of it in silence on the very next turn
    const supported = modelContextLength();
    const required = thinker.tokens.total;

    if (supported && supported < required) {
      log.error(
        chalk.red(
          `${entry.model} supports ${supported} tokens, but this session already needs ${required} - compact or clear it first`
        )
      );

      if (previous) {
        stayOn(previous);
        // preflight() replaced what was known about the old model, and
        // rebuild() counted with the new model's tokenizer - undo both
        await preflight();

        if (usesHfTokenizer()) {
          await ensureTokenizer();
        }

        thinker.rebuild(nextThought.messages);
        await thinker.count(nextThought.messages);
      }

      return;
    }

    if (nextThought.messages.some((message) => message.images?.length)) {
      warnIfBlind('the images already in this conversation');
    }

    log.info(
      chalk.green(
        `Switched to ${entry.model}${entry.tokenizer ? ` using the ${entry.tokenizer} tokenizer` : ''} - ${thinker.tokens.total} tokens`
      )
    );
  };

  // shows the limit, or changes it and saves it to config.yml for the runs
  // that follow. every reader of provider.contextLimit asks at call time, so
  // assigning it is enough for this session
  const contextLimit = async (value?: string) => {
    const supported = modelContextLength();

    if (value === undefined) {
      console.log(
        systemColor(
          `Context limit is ${provider.contextLimit} tokens${
            supported ? ` (${provider.model} supports ${supported})` : ''
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

    provider.contextLimit = limit;
    log.info(chalk.green(`Context limit set to ${limit} tokens`));

    try {
      saveSetting('provider', 'contextLimit', limit);
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
          `${provider.model} supports ${supported} - the prompt will be silently truncated`
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
  const paste = async (initial?: string) => {
    try {
      const text = await editor({
        message: 'Compose a prompt',
        postfix: '.md',
        waitForUserInput: false,
        default: initial
      });

      if (!text.trim()) {
        log.warn(systemColor('Nothing was pasted'));

        return;
      }

      addUserMessage(text);

      // kept out of the call, which is skipped with no one to hand it to - the
      // preview still has to be known for /undo to offer it back
      const line = recallable(text);

      rememberPrompt?.(line);
    } catch (error) {
      // log but swallow an error (if the editor could not be opened)
      if (error instanceof Error) {
        log.error(error.message);
      }
    }
  };

  // a screenshot that was never saved, from the clipboard. with a prompt after
  // it, the two are sent together - on its own it waits for the next prompt,
  // since an image with no question about it is rarely what the user meant
  const image = async (prompt?: string) => {
    const taken = await readClipboardImage();

    if (!taken) {
      const tried = clipboardTools();

      log.warn(
        systemColor(
          tried.length
            ? `There is no image on the clipboard (read with ${tried.join(' or ')})`
            : `Reading the clipboard is not supported on ${process.platform}`
        )
      );

      return;
    }

    // base64 holds three bytes in every four characters
    const bytes = Math.floor((taken.length * 3) / 4);

    if (bytes > maxImageBytes) {
      log.warn(
        chalk.red(
          `The clipboard image is ${(bytes / 1024 / 1024).toFixed(1)} MB, over the ${maxImageBytes / 1024 / 1024} MB an image can be`
        )
      );

      return;
    }

    pendingImages.push(taken);

    if (prompt) {
      addUserMessage(prompt, `/${Command.Image} ${prompt}`);

      return;
    }

    warnIfBlind('the image');
    log.info(
      systemColor(
        `Image attached to your next prompt (${pendingImages.length} queued)`
      )
    );
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

  // the "always" answers saved for this project, to look through and take back
  // one at a time - or, with add, a rule written by hand, globs and all
  const rules = async (value?: string) => {
    const usage = () =>
      log.error(
        chalk.red(
          'Expected /rules, or /rules add command|path|tool <pattern>, e.g. /rules add command yarn test*'
        )
      );

    if (value !== undefined) {
      const [, action, kind, pattern] =
        value.match(/^(\S+)\s+(\S+)\s+(.+)$/) ?? [];

      if (
        action !== 'add' ||
        (kind !== 'command' && kind !== 'path' && kind !== 'tool')
      ) {
        usage();

        return;
      }

      remember(kind, pattern);

      return;
    }

    const saved = loadRules();
    const kinds: RuleKind[] = ['command', 'path', 'tool'];
    const choices = kinds.flatMap((kind) =>
      saved[kind].map((pattern) => ({
        name: `${chalk.gray(kind.padEnd(8))}${pattern}`,
        // a kind never has a colon in it, so the first one splits them again
        value: `${kind}:${pattern}`,
        label: `the ${kind} rule ${pattern}`
      }))
    );

    // a picker with nothing in it would only be something to close
    if (!choices.length) {
      log.info(systemColor('No approval rules are saved for this project'));

      return;
    }

    try {
      await pickModel({
        message: 'Approval rules',
        choices,
        browse: true,
        remove: (choice) => {
          const split = choice.indexOf(':');

          forgetRule(
            choice.slice(0, split) as RuleKind,
            choice.slice(split + 1)
          );
        }
      });
    } catch (error) {
      // log but swallow an error (if the user cancelled the prompt)
      if (error instanceof Error) {
        log.error(error.message);
      }
    }
  };

  // the installed skills, to turn on and off. only an enabled one is listed in
  // the system prompt, so a change rebuilds it in place for the next turn - as
  // does a skill added, edited or removed on disk since it was last built
  const skills = async () => {
    let changed = reloadSkills();
    const installed = listSkills();

    // a picker with nothing in it would only be something to close
    if (!installed.length) {
      log.info(
        systemColor(
          `No skills are installed in ${skillsDir} or ${projectSkillsDir()}`
        )
      );
    } else {
      try {
        await pickSkills({
          message: 'Skills',
          choices: installed.map(({ name, description }) => ({
            name,
            description,
            enabled: isEnabled(name)
          })),
          toggle: (name, enabled) => {
            changed = true;
            setEnabled(name, enabled);
          }
        });
      } catch (error) {
        // log but swallow an error (if the user cancelled the prompt) -
        // whatever was toggled before then has already been saved, so it
        // still applies
        if (error instanceof Error) {
          log.error(error.message);
        }
      }
    }

    if (!changed) {
      return;
    }

    thinker.rebuild(nextThought.messages);
    await thinker.count(nextThought.messages);

    log.info(chalk.green(`Skills now use ${thinker.tokens.skills} tokens`));
  };

  // the configured MCP servers, and what became of each at startup - a server
  // that failed is otherwise only mentioned once, scrolled well out of view.
  // each can be turned on and off, and one that failed started over, and the
  // tools offered are rebuilt in place for the next turn
  const servers = async () => {
    if (!mcp.enabled) {
      log.info(systemColor('MCP is turned off (mcp.enabled / AQ_MCP)'));

      return;
    }

    const configured = listServers();

    if (!configured.length) {
      log.info(systemColor('No MCP servers are configured in config.yml'));

      return;
    }

    // a connection still under way when the picker closes is waited for, so
    // the tools it brings are there for the next turn
    const pending: Promise<unknown>[] = [];
    const track = <T>(work: Promise<T>) => {
      pending.push(work);

      return work;
    };

    try {
      await pickServers({
        message: 'MCP servers',
        choices: configured.map((server) => ({ ...server })),
        toggle: (name, enabled) =>
          track(setServerEnabled(name, enabled)).then((status) => ({
            ...status
          })),
        retry: (name) =>
          track(retryServer(name)).then((status) => ({ ...status }))
      });
    } catch (error) {
      // log but swallow an error (if the user cancelled the prompt) -
      // whatever was toggled before then has already been saved, so it still
      // applies
      if (error instanceof Error) {
        log.error(error.message);
      }
    }

    if (!pending.length) {
      return;
    }

    await Promise.allSettled(pending);

    setMcpTools(mcpTools());
    thinker.rebuild(nextThought.messages);
    await thinker.count(nextThought.messages);

    log.info(chalk.green(`MCP tools now use ${thinker.tokens.mcp} tokens`));
  };

  // a saved command, without its slash, sent as its prompt with whatever was
  // typed after its name. the history keeps the /command rather than the
  // prompt it stands for. false when no saved command has that name
  const sendCommand = (input: string) => {
    const line = input.trim();
    const [name] = line.split(/\s+/);
    const command = customCommands().find((custom) => custom.name === name);

    if (!command) {
      return false;
    }

    addUserMessage(expandCommand(command, line.slice(name.length)), `/${line}`);

    return true;
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
      case Command.Image:
        // the prompt is split into words above, and has to be sent exactly as
        // it was typed
        await image(input.trim().slice(name.length).trim() || undefined);
        break;
      case Command.Clear:
      case Command.Reset:
        await clear();
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
      case Command.Check:
        // a command of its own is split into words above, and has to reach
        // check mode exactly as it was typed
        await setCheck(input.trim().slice(name.length).trim() || undefined);
        break;
      case Command.Rules:
        // a pattern is split into words above, and has to be saved exactly as
        // it was typed
        await rules(input.trim().slice(name.length).trim() || undefined);
        break;
      case Command.Skills:
        await skills();
        break;
      case Command.Mcp:
        await servers();
        break;
      case Command.Help:
        console.log(systemColor('\n--- Available Commands ---'));
        Object.values(Command).forEach((cmd) =>
          console.log(`${systemColor('*')} /${cmd}`)
        );
        customCommands().forEach(({ name: custom, description }) =>
          console.log(
            `${systemColor('*')} /${custom}${description ? chalk.gray(` - ${description}`) : ''}`
          )
        );
        console.log(systemColor('---------------------------\n'));
        break;
      case Command.Quit:
        return Command.Quit;
      default:
        if (!sendCommand(input)) {
          log.error(chalk.red(`Tried to use unknown command /${name}!`));
        }
        break;
    }

    return undefined;
  };

  // a preview sent back from the history opens its prompt in the editor again,
  // rather than being sent as the one line it is. false for anything else
  const reopenPaste = async (line: string) => {
    const text = pasted.get(line);

    if (text === undefined) {
      return false;
    }

    await paste(text);

    return true;
  };

  // typed is what the user would want offered back, when it is not the content
  // itself - the /command that a saved prompt was sent with
  const addUserMessage = (content: string, typed?: string) => {
    // a skill added or edited since the last message is offered from this one
    // on. the prompt is only built again when the skills actually changed, so
    // otherwise it is exactly what was sent before
    if (reloadSkills()) {
      thinker.rebuild(nextThought.messages);
    }

    const { texts: attached, images: mentioned } = attachMentions(content);
    const images = [...pendingImages, ...mentioned];

    pendingImages = [];

    if (images.length) {
      warnIfBlind(images.length === 1 ? 'the image' : 'the images');
    }

    // a failed check's output goes along for as long as the prompt still says
    // it does. either way it is offered to this message alone - the next check
    // will have output of its own
    if (check.diagnostics && content.includes(diagnosticsMarker)) {
      attached.push(
        `Output of the failing check "${check.command}":\n${check.diagnostics}`
      );
    }

    check.diagnostics = undefined;

    const expanded = attached.length
      ? [content, ...attached].join('\n\n')
      : undefined;
    const message: AgentMessage = {
      role: 'user',
      content: expanded ?? content,
      ...(expanded || typed !== undefined ? { typed: typed ?? content } : {}),
      ...(images.length ? { images } : {})
    };

    nextThought.messages.push(message);
    currentTurn = beginTurn();
    turns.set(message, currentTurn);
    beginUserTurn();

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

    const interrupted = Boolean(nextThought.interrupted);

    if (nextThought.interrupted) {
      nextThought.interrupted = false;
      needsUserInput = true;
    } else if (!compactionStalled && thinker.tokens.total > compactAt()) {
      await compact();
    }

    // only once the model is done with the turn - a round that is still
    // calling tools would be checked halfway through its own work - and only
    // when a file has been written or patched since the last check
    if (needsUserInput && !failed && !interrupted && countSince(checkFrom)) {
      if (check.command) {
        checkFrom = currentTurn + 1;
      }

      await runCheck();

      // the next prompt offers to send the failure straight back to the model
      if (check.status === 'fail' && check.diagnostics && check.command) {
        prefill = fixPrompt(check.command);
      }
    }
  };

  // the whole of a non-interactive run: one prompt, then as many rounds as the
  // model wants until it hands the conversation back. true unless the model
  // call itself failed
  const runPrompt = async (prompt: string, schedule?: Schedule) => {
    // a saved command works here as at the prompt. anything else that starts
    // with a / - a path, say - is sent as it was given
    if (!(prompt.startsWith('/') && sendCommand(prompt.slice(1)))) {
      addUserMessage(prompt);
    }

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
    reopenPaste,
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
