import chalk from 'chalk';
import { input } from '@inquirer/prompts';
import {
  createPrompt,
  isEnterKey,
  useKeypress,
  useState,
  type Status
} from '@inquirer/core';

import { getLogger } from './logging';
import { yieldToUser } from './turn';
import { terminal } from './interactive';
import { approval as config } from './config';
import { isRemembered, remember } from './rules';
import {
  ApprovalAnswer,
  ApprovalMode,
  type ApprovalResult,
  type ApprovalSubject
} from '../types';

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
  [ApprovalMode.Manual]: chalk.bgYellow.black('every change is confirmed'),
  [ApprovalMode.Auto]: chalk.bgRed.white('changes apply without asking'),
  [ApprovalMode.Plan]: chalk.bgCyan.black('no changes can be made')
};

const hint = chalk.dim('shift+tab to cycle');

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
};

// what a typed answer means. an empty line keeps the old default of no
const answers: Record<string, ApprovalAnswer> = {
  y: ApprovalAnswer.Once,
  yes: ApprovalAnswer.Once,
  a: ApprovalAnswer.Always,
  always: ApprovalAnswer.Always,
  s: ApprovalAnswer.Stop,
  stop: ApprovalAnswer.Stop
};

const spoken: Record<ApprovalAnswer, string> = {
  [ApprovalAnswer.Once]: 'Yes',
  [ApprovalAnswer.Always]: 'Always',
  [ApprovalAnswer.No]: 'No',
  [ApprovalAnswer.Stop]: 'Stopped'
};

// @inquirer/confirm cannot be used here: its isTabKey is a bare name check, so
// it swallows shift+tab to toggle yes/no and there is no way to hook the key
const prompt = createPrompt<ApprovalAnswer, ApprovalRequest>(
  ({ message }, done) => {
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

        finish(answers[typed] ?? ApprovalAnswer.No);

        return;
      }

      setValue(rl.line);
    });

    if (status === 'done') {
      return `${message} ${chalk.cyan(value)}`;
    }

    return `${message} ${badges[mode]} ${chalk.dim(
      '(y)es / (N)o / (a)lways / (s)top'
    )} ${value}`;
  }
);

// asked once after every refusal, so no tool has to remember to do it. a bare
// no leaves the model guessing and it tends to retry the identical call
const askReason = async () => {
  const reason = await input({
    message: chalk.dim('Why not? (optional, enter to skip)')
  });

  return reason.trim() || undefined;
};

// the one way a tool reports a refusal, so the wording the model sees is the
// same whichever action was turned down
export const describeDenial = (action: string, reason?: string) =>
  `The user declined to ${action}.${reason ? ` They said: "${reason}"` : ''}`;

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

// approved means go ahead. auto answers itself, a remembered answer answers
// itself, and manual asks. plan never reaches here - mutating tools refuse
// before they have anything to confirm
export const requestApproval = async (
  message: string,
  subject?: ApprovalSubject
): Promise<ApprovalResult> => {
  if (approval.mode === ApprovalMode.Auto) {
    return { approved: true };
  }

  // an answer given earlier about this exact command or path stands until the
  // rules file says otherwise, which is what keeps a long task from asking
  // about the same test command twenty times
  if (subject && isRemembered(subject.kind, subject.value)) {
    log.debug(`Remembered approval for ${subject.kind} ${subject.value}`);

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

  // shift+tab out of the prompt and into auto counts as a yes, so this covers
  // that path too
  const answer = await prompt({ message });

  if (answer === ApprovalAnswer.Always) {
    if (subject) {
      remember(subject.kind, subject.value);
    }

    return { approved: true };
  }

  if (answer === ApprovalAnswer.Once) {
    return { approved: true };
  }

  if (answer === ApprovalAnswer.Stop) {
    // the run loop hands the keyboard back rather than letting the model try
    // again with a slightly different call
    yieldToUser();

    return { approved: false, stopped: true };
  }

  return { approved: false, reason: await askReason() };
};
