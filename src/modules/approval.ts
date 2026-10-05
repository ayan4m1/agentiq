import chalk from 'chalk';
import { resolve } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { editor, input } from '@inquirer/prompts';
import {
  createPrompt,
  isEnterKey,
  useKeypress,
  useState,
  type Status
} from '@inquirer/core';

import { getLogger } from './logging';
import { terminal, yieldToUser } from './turn';
import { home, approval as config } from './config';
import { toPosix } from './ignore';
import {
  ApprovalAnswer,
  ApprovalMode,
  type ApprovalResult,
  type ApprovalSubject,
  type Editable
} from '../types';
import { describeError, slugFor } from '../utils';

const log = getLogger('approval');

// the one piece of mutable session state - every mutating tool reads it, and
// shift+tab writes it from whichever prompt happens to be on screen
export const approval = { mode: config.mode };

const nextModes: Record<ApprovalMode, ApprovalMode> = {
  [ApprovalMode.Manual]: ApprovalMode.Auto,
  [ApprovalMode.Auto]: ApprovalMode.Plan,
  [ApprovalMode.Plan]: ApprovalMode.Manual
};

const badges: Record<ApprovalMode, string> = {
  [ApprovalMode.Manual]: chalk.yellow('[manual]'),
  [ApprovalMode.Auto]: chalk.red('[ auto ]'),
  [ApprovalMode.Plan]: chalk.cyan('[ plan ]')
};

const banners: Record<ApprovalMode, string> = {
  [ApprovalMode.Manual]: chalk.bgYellow('every change is confirmed'),
  [ApprovalMode.Auto]: chalk.bgRed('changes apply without asking'),
  [ApprovalMode.Plan]: chalk.bgCyan('no changes can be made')
};

const hint = chalk.gray('shift+tab to cycle');

export const describeMode = () => badges[approval.mode];

const isPlanning = () => approval.mode === ApprovalMode.Plan;

export const setMode = (mode: ApprovalMode) => {
  approval.mode = mode;

  // a mode change can happen mid-prompt from a keypress, so announce it rather
  // than relying on the caller to redraw something
  console.log(`${banners[mode]} ${hint}`);

  return mode;
};

export const cycleMode = () => setMode(nextModes[approval.mode]);

type ApprovalRequest = {
  message: string;
  // whether there is anything to edit - only then is (e)dit offered
  editable: boolean;
};

// what a typed answer means. an empty line keeps the old default of no
const answers: Record<string, ApprovalAnswer> = {
  y: ApprovalAnswer.Once,
  yes: ApprovalAnswer.Once,
  a: ApprovalAnswer.Always,
  always: ApprovalAnswer.Always,
  s: ApprovalAnswer.Stop,
  stop: ApprovalAnswer.Stop,
  e: ApprovalAnswer.Edit,
  edit: ApprovalAnswer.Edit
};

const spoken: Record<ApprovalAnswer, string> = {
  [ApprovalAnswer.Once]: 'Yes',
  [ApprovalAnswer.Always]: 'Always',
  [ApprovalAnswer.No]: 'No',
  [ApprovalAnswer.Stop]: 'Stopped',
  [ApprovalAnswer.Edit]: 'Edit'
};

// an answer that was not on offer counts as no, the same as any typo
export const readAnswer = (typed: string, editable: boolean) => {
  const answer = answers[typed] ?? ApprovalAnswer.No;

  return answer === ApprovalAnswer.Edit && !editable
    ? ApprovalAnswer.No
    : answer;
};

// @inquirer/confirm cannot be used here: its isTabKey is a bare name check, so
// it swallows shift+tab to toggle yes/no and there is no way to hook the key
const prompt = createPrompt<ApprovalAnswer, ApprovalRequest>(
  ({ message, editable }, done) => {
    const [status, setStatus] = useState<Status>('idle');
    const [value, setValue] = useState('');
    const [mode, setCurrentMode] = useState(approval.mode);

    const finish = (answer: ApprovalAnswer) => {
      setValue(spoken[answer]);
      setStatus('done');
      done(answer);
    };

    useKeypress((key, rl) => {
      if (status !== 'idle') {
        return;
      }

      if (key.name === 'tab') {
        // readline echoes the tab into the line buffer before we see the key, so
        // strip it by rewriting the line as it stood beforehand
        rl.clearLine(0);
        rl.write(value);

        if (!key.shift) {
          return;
        }

        const next = cycleMode();

        setCurrentMode(next);

        // landing in auto means the user just said yes to everything, including
        // the action they are being asked about right now
        if (next === ApprovalMode.Auto) {
          finish(ApprovalAnswer.Once);
        }

        return;
      }

      if (isEnterKey(key)) {
        const typed = value.trim().toLowerCase();

        finish(readAnswer(typed, editable));

        return;
      }

      setValue(rl.line);
    });

    if (status === 'done') {
      return `${message} ${chalk.cyan(value)}`;
    }

    return `${message} ${badges[mode]} ${chalk.gray(
      `(y)es / (N)o / (a)lways / (s)top${editable ? ' / (e)dit' : ''}`
    )} ${value}`;
  }
);

// asked once after every refusal, so no tool has to remember to do it. a bare
// no leaves the model guessing and it tends to retry the identical call
const askReason = async () => {
  const reason = await input({
    message: `Why not? ${chalk.gray('(optional, enter to skip)')}`
  });

  return reason.trim() || undefined;
};

// the one way a tool reports a refusal, so the wording the model sees is the
// same whichever action was turned down
export const describeDenial = (action: string, reason?: string) =>
  `The user declined to ${action}.${reason ? ` They said: "${reason}"` : ''}`;

// a command the user rewrote ran in place of the one the model asked for, and
// the model has to know that to make sense of the output it gets back
export const describeEditedCommand = (command: string) =>
  `The user changed the command to "${command}" before running it.`;

// the sibling of describeDenial for the refusal that happens before there is
// anything to confirm. `subject` completes "Plan mode is active, so ..." -
// every mutating tool returns this when it is set, and nothing else
export const refusePlanning = (subject: string) => {
  if (!isPlanning()) {
    return;
  }

  log.debug('Plan mode is active');

  return `Plan mode is active, so ${subject}. Use the present_plan tool to propose an approach and ask to start work.`;
};

// beside the sessions, and keyed the same way: an answer given about one
// project says nothing about another
const rulesDir = resolve(home, 'approvals');

export type RuleKind = 'command' | 'path' | 'tool';

type Rules = Record<RuleKind, string[]>;

const empty = (): Rules => ({ command: [], path: [], tool: [] });

const pathFor = () => resolve(rulesDir, `${slugFor(process.cwd())}.json`);

const escapeRegExp = (value: string) =>
  value.replace(/[.+?^${}()|[\]\\]/g, (match) => `\\${match}`);

// only ever written back verbatim, but the file is plain json and a pattern
// typed there by hand should do what it looks like it does. ** spans
// separators and * does not, the same distinction glob makes
export const matchesRule = (pattern: string, value: string) => {
  if (pattern === value) {
    return true;
  }

  if (!pattern.includes('*')) {
    return false;
  }

  const source = pattern
    .split('**')
    .map((part) => part.split('*').map(escapeRegExp).join('[^/]*'))
    .join('.*');

  try {
    return new RegExp(`^${source}$`).test(value);
  } catch {
    // a pattern that will not compile is one the user has to fix, and it must
    // not take the session down on the way
    log.warn(
      `Ignoring an approval rule that is not a valid pattern: ${pattern}`
    );

    return false;
  }
};

// a path is stored relative to the project when it is inside it, so the rules
// still mean something on another machine or after the directory moves
export const normalizePath = (value: string) => {
  const absolute = toPosix(resolve(value));
  const root = `${toPosix(process.cwd())}/`;

  return absolute.startsWith(root) ? absolute.slice(root.length) : absolute;
};

const normalize = (kind: RuleKind, value: string) =>
  kind === 'path' ? normalizePath(value) : value.trim();

export const loadRules = (): Rules => {
  const path = pathFor();

  if (!existsSync(path)) {
    return empty();
  }

  try {
    const parsed = JSON.parse(readFileSync(path).toString());

    return {
      command: Array.isArray(parsed?.command) ? parsed.command : [],
      path: Array.isArray(parsed?.path) ? parsed.path : [],
      // absent from a file written before MCP tools could be approved
      tool: Array.isArray(parsed?.tool) ? parsed.tool : []
    };
  } catch (error) {
    // a hand-edited file with a typo in it should cost the rules, not the run
    log.warn(`Could not read ${path}: ${describeError(error)}`);

    return empty();
  }
};

// the rule that allows this, so an approval nobody was asked for can say why
export const findRule = (kind: RuleKind, value: string) => {
  const wanted = normalize(kind, value);

  return loadRules()[kind].find((pattern) => matchesRule(pattern, wanted));
};

export const isRemembered = (kind: RuleKind, value: string) =>
  findRule(kind, value) !== undefined;

const saveRules = (rules: Rules) => {
  const path = pathFor();

  try {
    mkdirSync(rulesDir, { recursive: true });
    writeFileSync(path, `${JSON.stringify(rules, null, 2)}\n`);

    return true;
  } catch (error) {
    log.warn(`Could not write ${path}: ${describeError(error)}`);

    return false;
  }
};

// written exactly as it was approved rather than widened into a pattern: a
// rule that turns out to cover more than the user meant is the one thing this
// must not do quietly
export const remember = (kind: RuleKind, value: string) => {
  const wanted = normalize(kind, value);
  const rules = loadRules();

  if (rules[kind].includes(wanted)) {
    return;
  }

  rules[kind].push(wanted);

  if (saveRules(rules)) {
    log.info(`Will not ask about this ${kind} again: ${wanted}`);
  }
};

// takes the pattern as it is stored rather than normalizing it, since it comes
// from the listing /rules showed and not from something the model asked for
export const forgetRule = (kind: RuleKind, pattern: string) => {
  const rules = loadRules();

  if (!rules[kind].includes(pattern)) {
    return;
  }

  rules[kind] = rules[kind].filter((rule) => rule !== pattern);
  saveRules(rules);
};

// editors do things to a file nobody asked them to: most add a final newline,
// and some write lf over a crlf file. undone here so an edit that only fixed
// one line does not show up as a change to every line, or to the last one
export const restoreEndings = (original: string, edited: string) => {
  let text = edited;

  if (original.includes('\r\n') && !text.includes('\r\n')) {
    text = text.replace(/\n/g, '\r\n');
  }

  if (!/\r?\n$/.test(original)) {
    text = text.replace(/\r?\n$/, '');
  }

  return text;
};

// the proposal as the user left it in their editor, or what it was before when
// there is nothing usable to take from it
const editProposal = async (
  current: string,
  editable: Editable,
  subject?: ApprovalSubject
) => {
  let text: string;

  try {
    text = await editor({
      message: 'Edit before approving',
      waitForUserInput: false,
      default: current,
      // left out for a command, so inquirer's own default applies
      ...(editable.extension ? { postfix: editable.extension } : {})
    });
  } catch (error) {
    // the editor could not be opened - the proposal stands and is asked about
    // again, rather than the whole request failing over it
    log.error(`Could not open an editor: ${describeError(error)}`);

    return current;
  }

  // a command runs as one line, and a blank one would run nothing at all
  if (subject?.kind === 'command') {
    const command = text.trim();

    if (!command) {
      log.warn('The command was left empty, so it is unchanged');

      return current;
    }

    return command;
  }

  return restoreEndings(current, text);
};

// approved means go ahead. auto answers itself, a remembered answer answers
// itself, and manual asks. plan never reaches here - mutating tools refuse
// before they have anything to confirm. given something editable, the user can
// rewrite it before saying yes, and is asked again about what they wrote
export const requestApproval = async (
  message: string,
  subject?: ApprovalSubject,
  editable?: Editable
): Promise<ApprovalResult> => {
  if (approval.mode === ApprovalMode.Auto) {
    return { approved: true };
  }

  // an answer given earlier about this exact command or path stands until the
  // rules file says otherwise, which is what keeps a long task from asking
  // about the same test command twenty times
  const rule = subject && findRule(subject.kind, subject.value);

  if (rule !== undefined) {
    // said out loud, since manual mode going ahead without asking would
    // otherwise look like a bug - and /rules is where to take it back
    log.info(chalk.gray(`✔ allowed by rule: ${rule}`));

    return { approved: true };
  }

  // nobody is there to ask, so only what was already allowed can go ahead -
  // said as a reason so the model knows not to keep asking
  if (!terminal.interactive) {
    log.debug('Refusing approval while running non-interactively');

    return {
      approved: false,
      reason:
        'agentiq is running non-interactively, so nobody can approve this. Only actions allowed by a saved rule can run - finish what you can without it.'
    };
  }

  let current = editable?.content ?? '';
  // shift+tab out of the prompt and into auto counts as a yes, so this covers
  // that path too
  let answer = await prompt({ message, editable: !!editable });

  while (answer === ApprovalAnswer.Edit && editable) {
    current = await editProposal(current, editable, subject);

    // saving is not approval: an editor has no clean way to back out, so the
    // result is shown and asked about like the original was
    answer = await prompt({ message: editable.show(current), editable: true });
  }

  const edited =
    editable && current !== editable.content ? { edited: current } : {};

  if (answer === ApprovalAnswer.Always) {
    if (subject) {
      // the command that will actually run is the one worth remembering. a
      // path is the same path however its contents were edited
      const value =
        subject.kind === 'command' && edited.edited !== undefined
          ? edited.edited
          : subject.value;

      remember(subject.kind, value);
    }

    return { approved: true, ...edited };
  }

  if (answer === ApprovalAnswer.Once) {
    return { approved: true, ...edited };
  }

  if (answer === ApprovalAnswer.Stop) {
    // the run loop hands the keyboard back rather than letting the model try
    // again with a slightly different call
    yieldToUser();

    return { approved: false, stopped: true };
  }

  return { approved: false, reason: await askReason() };
};
