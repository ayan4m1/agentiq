import { mock } from 'node:test';

import type { ModuleMock } from './module';

export type FakeSpinner = {
  // both hand the spinner back, as ora's do, so calls can be chained
  start: () => FakeSpinner;
  stop: () => FakeSpinner;
  isSpinning: boolean;
  suffixText?: string;
};

type SpinnerOptions = { discardStdin?: boolean; suffixText?: string };

// the spinner draws on a real terminal, which a test does not have - so a fake
// stands in for it, recording how it was set up and when it ran
export const fakeOra = () => {
  let spinning = false;
  let lastSpinner: FakeSpinner | undefined;
  const start = mock.fn(function (this: FakeSpinner) {
    spinning = true;

    return this;
  });
  const stop = mock.fn(function (this: FakeSpinner) {
    spinning = false;

    return this;
  });
  const ora = mock.fn((options: SpinnerOptions = {}): FakeSpinner => {
    lastSpinner = {
      start,
      stop,
      get isSpinning() {
        return spinning;
      },
      suffixText: options.suffixText
    };

    return lastSpinner;
  });

  return {
    exports: { default: ora } satisfies ModuleMock<typeof import('ora')>,
    ora,
    start,
    stop,
    get spinning() {
      return spinning;
    },
    // the one most recently made, which the code under test may have changed
    get lastSpinner() {
      return lastSpinner;
    },
    reset: () => {
      ora.mock.resetCalls();
      start.mock.resetCalls();
      stop.mock.resetCalls();
      spinning = false;
      lastSpinner = undefined;
    }
  };
};
