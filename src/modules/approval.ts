import chalk from 'chalk';
import {
  createPrompt,
  isEnterKey,
  useKeypress,
  useState,
  type Status
} from '@inquirer/core';

import { approval as config } from './config';
import { ApprovalMode } from '../types';

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
  [ApprovalMode.Auto]: chalk.red('[auto]'),
  [ApprovalMode.Plan]: chalk.cyan('[plan]')
};

const banners: Record<ApprovalMode, string> = {
  [ApprovalMode.Manual]: chalk.bgYellow.black(
    ' manual - every change is confirmed '
  ),
  [ApprovalMode.Auto]: chalk.bgRed.white(
    ' auto - changes apply without asking '
  ),
  [ApprovalMode.Plan]: chalk.bgCyan.black(' plan - no changes can be made ')
};

export const hint = chalk.dim('shift+tab to cycle');

export const describeMode = () => badges[approval.mode];

export const isPlanning = () => approval.mode === ApprovalMode.Plan;

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

// @inquirer/confirm cannot be used here: its isTabKey is a bare name check, so
// it swallows shift+tab to toggle yes/no and there is no way to hook the key
const prompt = createPrompt<boolean, ApprovalRequest>(({ message }, done) => {
  const [status, setStatus] = useState<Status>('idle');
  const [value, setValue] = useState('');
  const [mode, setCurrentMode] = useState(approval.mode);

  const finish = (answer: boolean) => {
    setValue(answer ? 'Yes' : 'No');
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
        finish(true);
      }

      return;
    }

    if (isEnterKey(key)) {
      const answer = value.trim().toLowerCase();

      // nothing typed keeps the old default of no
      finish('yes'.startsWith(answer) && answer !== '');

      return;
    }

    setValue(rl.line);
  });

  if (status === 'done') {
    return `${chalk.green('?')} ${message} ${chalk.cyan(value)}`;
  }

  return `${chalk.green('?')} ${message} ${badges[mode]} ${chalk.dim('(y/N)')} ${value}`;
});

// true means go ahead. auto answers itself; manual asks. plan never reaches
// here - mutating tools refuse before they have anything to confirm
export const requestApproval = async (message: string) => {
  if (approval.mode === ApprovalMode.Auto) {
    return true;
  }

  return prompt({ message });
};
