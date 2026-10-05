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
  useRef,
  useState,
  type Status
} from '@inquirer/core';

import { stopReading } from './interrupt';

export type PickerChoice = {
  name: string;
  value: string;
  // the server was asked and does not have it - it can still be chosen, and
  // preflight says why that did not work
  missing?: boolean;
  // why r does nothing on this row - any row without one can be removed
  locked?: string;
  // how the confirmation names this row, when the value alone would not read
  // well there
  label?: string;
};

type PickerRequest = {
  message: string;
  choices: PickerChoice[];
  default?: string;
  // called the moment removal is confirmed, so it has already happened by the
  // time the prompt finishes - or is cancelled
  remove: (value: string) => void;
  // a list to look through and prune rather than choose from - enter closes it
  // the way escape does, and the prompt finishes once nothing is left
  browse?: boolean;
};

// escape resolves with nothing rather than a value
type Picked = string | undefined;

// @inquirer/figures and @inquirer/ansi are only transitive dependencies, so
// the two pieces of them select uses are spelled out here instead
const pointer = '❯';
const hideCursor = '\u001B[?25l';

// done() only settles the promise - inquirer closes its readline a microtask
// later, and closing switches raw mode off. the read is stopped here first, or
// on windows the switch leaves a cooked read behind that waits for enter
const finish = <T>(
  rl: { input: unknown },
  done: (value: T) => void,
  value: T
) => {
  stopReading(rl.input as NodeJS.ReadableStream);
  done(value);
};

const describeKeys = (keys: string[][]) =>
  keys
    .map(([key, action]) => `${chalk.bold(key)} ${chalk.gray(action)}`)
    .join(chalk.gray(' • '));

const help = describeKeys([
  ['esc', 'cancel'],
  ['↑↓', 'navigate'],
  ['⏎', 'select'],
  ['r', 'remove']
]);

const browseHelp = describeKeys([
  ['esc/⏎', 'close'],
  ['↑↓', 'navigate'],
  ['r', 'remove']
]);

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
      setActive(Math.max(0, Math.min(active, remaining.length - 1)));

      // an empty list has nothing left to browse
      if (config.browse && !remaining.length) {
        setStatus('done');
        finish(rl, done, undefined);
      }

      return;
    }

    if (key.name === 'escape' || (config.browse && isEnterKey(key))) {
      setStatus(config.browse ? 'done' : 'cancelled');
      finish(rl, done, undefined);
    } else if (!selected) {
      // nothing to move to, choose or remove
      return;
    } else if (isEnterKey(key)) {
      setStatus('done');
      finish(rl, done, selected.value);
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
  if (status === 'done' && (config.browse || !selected)) {
    return `${prefix} ${message}`;
  }

  if (status === 'done') {
    return `${prefix} ${message} ${theme.style.answer(selected.value || selected.name)}`;
  }

  if (status === 'cancelled') {
    return `${prefix} ${message} ${chalk.gray('cancelled')}`;
  }

  const footer = confirming
    ? `Remove ${confirming.label ?? confirming.value}? ${chalk.gray('(y/N)')}`
    : config.browse
      ? browseHelp
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

export type SkillChoice = {
  name: string;
  description: string;
  enabled: boolean;
};

type SkillsRequest = {
  message: string;
  choices: SkillChoice[];
  // called on every change, so it has already happened by the time the
  // prompt closes - there is nothing to cancel
  toggle: (name: string, enabled: boolean) => void;
};

const skillsHelp = describeKeys([
  ['esc/⏎', 'close'],
  ['↑↓', 'navigate'],
  ['space', 'toggle'],
  ['a', 'all/none']
]);

// a with everything on turns everything off, and otherwise turns it all on -
// the same as a checkbox list's select-all
export const toggleAll = (items: SkillChoice[]) => {
  const enabled = !items.every((item) => item.enabled);

  return items.map((item) => ({ ...item, enabled }));
};

// @inquirer/checkbox only reports what was ticked once it closes, and each
// change here has to be saved as it is made - so this is the same list with a
// toggle callback, closing on enter or escape the way a browsing pickModel does
export const pickSkills = createPrompt<void, SkillsRequest>((config, done) => {
  const theme = makeTheme();
  const [status, setStatus] = useState<Status>('idle');
  const [items, setItems] = useState(config.choices);
  const [active, setActive] = useState(0);
  const prefix = usePrefix({ status, theme });
  const selected = items[active];

  const apply = (next: SkillChoice[]) => {
    next.forEach((item, index) => {
      if (item.enabled !== items[index].enabled) {
        config.toggle(item.name, item.enabled);
      }
    });
    setItems(next);
  };

  useKeypress((key, rl) => {
    if (status !== 'idle') {
      return;
    }

    // readline has already echoed whatever was typed into the line, and none
    // of it is meant to be kept
    rl.clearLine(0);

    if (key.name === 'escape' || isEnterKey(key)) {
      setStatus('done');
      finish(rl, done, undefined);
    } else if (!selected) {
      return;
    } else if (isUpKey(key, theme.keybindings)) {
      setActive((active - 1 + items.length) % items.length);
    } else if (isDownKey(key, theme.keybindings)) {
      setActive((active + 1) % items.length);
    } else if (key.name === 'space') {
      apply(
        items.map((item) =>
          item === selected ? { ...item, enabled: !item.enabled } : item
        )
      );
    } else if (key.name === 'a') {
      apply(toggleAll(items));
    }
  });

  const page = usePagination({
    items,
    active,
    renderItem: ({ item, isActive }) => {
      const mark = item.enabled ? '◉' : '◯';
      const line = `${mark} ${item.name}`;

      return isActive
        ? `${theme.style.highlight(pointer)} ${theme.style.highlight(line)}`
        : `  ${item.enabled ? line : chalk.gray(line)}`;
    },
    pageSize: 7
  });
  const message = theme.style.message(config.message, status);

  // hooks are matched up by call order, so this comes after every one of them
  if (status === 'done') {
    const count = items.filter((item) => item.enabled).length;

    return `${prefix} ${message} ${theme.style.answer(`${count} of ${items.length} enabled`)}`;
  }

  // one line of it, since a description can run to a paragraph
  const description = selected?.description.replace(/\s+/g, ' ').trim() ?? '';
  const columns = process.stdout.columns || 80;
  const shown =
    description.length > columns - 2
      ? `${description.slice(0, columns - 3)}…`
      : description;

  return `${[
    `${prefix} ${message}`,
    page,
    ' ',
    shown ? chalk.gray(shown) : '',
    skillsHelp
  ]
    .filter(Boolean)
    .join('\n')}${hideCursor}`;
});

export type ServerChoice = {
  name: string;
  transport: 'stdio' | 'http';
  tools: number;
  error?: string;
  enabled: boolean;
  // waiting on a connection started from this list - its row takes no keys
  // until that settles
  connecting?: boolean;
};

// what a server's row reads as once a toggle or retry has settled
type ServerUpdate = Omit<ServerChoice, 'connecting'>;

type ServersRequest = {
  message: string;
  choices: ServerChoice[];
  // called on every change, so it has already happened by the time the
  // prompt closes. turning a server on connects it, which is what is awaited
  toggle: (name: string, enabled: boolean) => Promise<ServerUpdate>;
  retry: (name: string) => Promise<ServerUpdate>;
};

const serversHelp = describeKeys([
  ['esc/⏎', 'close'],
  ['↑↓', 'navigate'],
  ['space', 'toggle'],
  ['r', 'retry']
]);

const describeServer = (item: ServerChoice) => {
  if (!item.enabled) {
    return chalk.gray('off');
  }

  if (item.connecting) {
    return chalk.gray('connecting…');
  }

  return item.error ? chalk.red('failed') : `${item.tools} tools`;
};

// the same list as pickSkills, except that a change has to connect or stop a
// server - so a row waits on that, and r starts a failed one over again
export const pickServers = createPrompt<void, ServersRequest>(
  (config, done) => {
    const theme = makeTheme();
    const [status, setStatus] = useState<Status>('idle');
    const [items, setItems] = useState(config.choices);
    const [active, setActive] = useState(0);
    const [error, setError] = useState<string>();
    // a connection can settle after the prompt has closed, when there is
    // nothing left to draw it on
    const closed = useRef(false);
    const prefix = usePrefix({ status, theme });
    const selected = items[active];

    // the reducer form, since the list may have changed while this waited
    const update = (name: string, changes: Partial<ServerChoice>) => {
      if (closed.current) {
        return;
      }

      setItems((current: ServerChoice[]) =>
        current.map((item) =>
          item.name === name ? { ...item, ...changes } : item
        )
      );
    };

    const settle = (name: string, work: Promise<ServerUpdate>) => {
      update(name, { connecting: true });
      work.then(
        // a server that came up has no error, rather than the old one
        (result) =>
          update(name, { error: undefined, ...result, connecting: false }),
        (failure: unknown) =>
          update(name, {
            connecting: false,
            error: failure instanceof Error ? failure.message : String(failure)
          })
      );
    };

    useKeypress((key, rl) => {
      if (status !== 'idle') {
        return;
      }

      // readline has already echoed whatever was typed into the line, and
      // none of it is meant to be kept
      rl.clearLine(0);
      setError(undefined);

      if (key.name === 'escape' || isEnterKey(key)) {
        setStatus('done');
        closed.current = true;
        finish(rl, done, undefined);
      } else if (!selected) {
        return;
      } else if (isUpKey(key, theme.keybindings)) {
        setActive((active - 1 + items.length) % items.length);
      } else if (isDownKey(key, theme.keybindings)) {
        setActive((active + 1) % items.length);
      } else if (selected.connecting) {
        // the row is not settled enough to change again
        return;
      } else if (key.name === 'space') {
        const enabled = !selected.enabled;

        update(selected.name, { enabled, tools: 0, error: undefined });
        settle(selected.name, config.toggle(selected.name, enabled));
      } else if (key.name === 'r') {
        if (!selected.enabled || !selected.error) {
          setError('Only a server that failed can be retried');
        } else {
          settle(selected.name, config.retry(selected.name));
        }
      }
    });

    const page = usePagination({
      items,
      active,
      renderItem: ({ item, isActive }) => {
        const mark = item.enabled ? '◉' : '◯';
        const line = `${mark} ${item.name} ${chalk.gray(`(${item.transport})`)}`;
        const state = describeServer(item);

        return isActive
          ? `${theme.style.highlight(pointer)} ${theme.style.highlight(line)} - ${state}`
          : `  ${item.enabled ? line : chalk.gray(line)} - ${state}`;
      },
      pageSize: 7
    });
    const message = theme.style.message(config.message, status);

    // hooks are matched up by call order, so this comes after every one of them
    if (status === 'done') {
      const count = items.filter((item) => item.enabled).length;

      return `${prefix} ${message} ${theme.style.answer(`${count} of ${items.length} enabled`)}`;
    }

    // one line of it, since an error can run on
    const reason =
      selected?.enabled && !selected.connecting && selected.error
        ? selected.error.replace(/\s+/g, ' ').trim()
        : '';
    const columns = process.stdout.columns || 80;
    const shown =
      reason.length > columns - 2 ? `${reason.slice(0, columns - 3)}…` : reason;

    return `${[
      `${prefix} ${message}`,
      page,
      ' ',
      shown ? chalk.red(shown) : '',
      error ? theme.style.error(error) : '',
      serversHelp
    ]
      .filter(Boolean)
      .join('\n')}${hideCursor}`;
  }
);
