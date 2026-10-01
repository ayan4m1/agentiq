import { mock } from 'node:test';

import type { ModuleMock } from './module';

// escape is watched for on a real terminal, which a test does not have - so the
// watcher hands its callback over instead, for a test to press escape with
export const fakeInterrupt = () => {
  let onInterrupt: (() => void) | undefined;
  const stopWatching = mock.fn();
  const watchForInterrupt = mock.fn((callback: () => void) => {
    onInterrupt = callback;

    return stopWatching;
  });

  return {
    exports: { watchForInterrupt } satisfies ModuleMock<
      typeof import('../../src/modules/interrupt')
    >,
    watchForInterrupt,
    stopWatching,
    // does nothing until something is watching, like the real key
    pressEscape: () => onInterrupt?.(),
    reset: () => {
      watchForInterrupt.mock.resetCalls();
      stopWatching.mock.resetCalls();
      onInterrupt = undefined;
    }
  };
};
