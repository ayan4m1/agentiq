import chalk from 'chalk';
import {
  createPrompt,
  isDownKey,
  isEnterKey,
  isUpKey,
  makeTheme,
  usePagination,
  usePrefix,
  useKeypress,
  useState,
  type Status
} from '@inquirer/core';

export type PickerChoice = {
  name: string;
  value: string;
  // the server was asked and does not have it - it can still be chosen, and
  // preflight says why that did not work
  missing?: boolean;
  // why r does nothing on this row - any row without one can be removed
  locked?: string;
};

type PickerRequest = {
  message: string;
  choices: PickerChoice[];
  default?: string;
  // called the moment removal is confirmed, so it has already happened by the
  // time the prompt finishes - or is cancelled
  remove: (value: string) => void;
};

// escape resolves with nothing rather than a value
type Picked = string | undefined;

// @inquirer/figures and @inquirer/ansi are only transitive dependencies, so
// the two pieces of them select uses are spelled out here instead
const pointer = '❯';
const hideCursor = '\u001B[?25l';

const help = [
  ['esc', 'cancel'],
  ['↑↓', 'navigate'],
  ['⏎', 'select'],
  ['r', 'remove']
]
  .map(([key, action]) => `${chalk.bold(key)} ${chalk.gray(action)}`)
  .join(chalk.gray(' • '));

// @inquirer/select has no way to hook a key of its own, so this is the same
// list with r to remove the highlighted entry and red for one ollama lacks
export const pickModel = createPrompt<Picked, PickerRequest>((config, done) => {
  const theme = makeTheme();
  const [status, setStatus] = useState<Status>('idle');
  const [items, setItems] = useState(config.choices);
  const [active, setActive] = useState(
    Math.max(
      0,
      config.choices.findIndex(({ value }) => value === config.default)
    )
  );
  const [confirming, setConfirming] = useState<PickerChoice>();
  const [error, setError] = useState<string>();
  const prefix = usePrefix({ status, theme });
  const selected = items[active];

  useKeypress((key, rl) => {
    if (status !== 'idle') {
      return;
    }

    // readline has already echoed whatever was typed into the line, and none
    // of it is meant to be kept
    rl.clearLine(0);
    setError(undefined);

    if (confirming) {
      setConfirming(undefined);

      if (key.name !== 'y') {
        return;
      }

      config.remove(confirming.value);

      const remaining = items.filter((item) => item !== confirming);

      setItems(remaining);
      setActive(Math.min(active, remaining.length - 1));

      return;
    }

    if (key.name === 'escape') {
      setStatus('cancelled');
      done(undefined);
    } else if (isEnterKey(key)) {
      setStatus('done');
      done(selected.value);
    } else if (isUpKey(key, theme.keybindings)) {
      setActive((active - 1 + items.length) % items.length);
    } else if (isDownKey(key, theme.keybindings)) {
      setActive((active + 1) % items.length);
    } else if (key.name === 'r') {
      if (selected.locked) {
        setError(selected.locked);
      } else {
        setConfirming(selected);
      }
    }
  });

  const page = usePagination({
    items,
    active,
    renderItem: ({ item, isActive }) => {
      const name = item.missing ? chalk.red(item.name) : item.name;

      return isActive
        ? `${theme.style.highlight(pointer)} ${item.missing ? name : theme.style.highlight(name)}`
        : `  ${name}`;
    },
    pageSize: 7
  });
  const message = theme.style.message(config.message, status);

  // hooks are matched up by call order, so this comes after every one of them
  if (status === 'done') {
    return `${prefix} ${message} ${theme.style.answer(selected.value || selected.name)}`;
  }

  if (status === 'cancelled') {
    return `${prefix} ${message} ${chalk.gray('cancelled')}`;
  }

  const footer = confirming
    ? `Remove ${confirming.value}? ${chalk.gray('(y/N)')}`
    : help;

  return `${[
    `${prefix} ${message}`,
    page,
    ' ',
    error ? theme.style.error(error) : '',
    footer
  ]
    .filter(Boolean)
    .join('\n')}${hideCursor}`;
});
