import type { Ora } from 'ora';

import { describeElapsed } from '../utils';

const tickMs = 1000;

const bracketed = (elapsed: string) => `(${elapsed})`;

// counts up beside a spinner, so a wait that runs long - a model slow to load
// or to answer, a check that takes its time - shows how long it has been at it.
// ora redraws on its own frame timer, which picks up the new text. the clock
// never holds the process open, and the returned function stops it
export const showElapsed = (
  spinner: Pick<Ora, 'suffixText'>,
  describe: (elapsed: string) => string = bracketed
) => {
  const startedAt = Date.now();

  spinner.suffixText = describe(describeElapsed(0));

  const clock = setInterval(() => {
    spinner.suffixText = describe(describeElapsed(Date.now() - startedAt));
  }, tickMs).unref();

  return () => clearInterval(clock);
};
