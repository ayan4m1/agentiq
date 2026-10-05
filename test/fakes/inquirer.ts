import { mock, type Mock } from 'node:test';

import type { ModuleMock } from './module';

type Prompts = typeof import('@inquirer/prompts');

// every prompt reads the real terminal, so each one the test does not hand over
// is a mock that answers nothing - the ones a test cares about, it passes in
export const fakePrompts = <O extends ModuleMock<Prompts>>(
  overrides: O = {} as O
) => {
  const exports = {
    confirm: mock.fn(),
    editor: mock.fn(),
    input: mock.fn(),
    select: mock.fn(),
    ...overrides
  } satisfies ModuleMock<Prompts>;

  return { exports, ...exports };
};

// a prompt of our own is built on @inquirer/core and reads the real terminal,
// so it is replaced by one that answers whatever the test says to
export const fakeInquirerCore = () => {
  const answer =
    mock.fn<
      (config: { message: string; editable?: boolean }) => Promise<string>
    >();

  return {
    exports: {
      createPrompt: () => answer,
      isEnterKey: () => false,
      useKeypress: () => {},
      useState: (value: unknown) => [value, () => {}]
    } satisfies ModuleMock<typeof import('@inquirer/core')>,
    answer
  };
};

// mockImplementationOnce aims at the next call unless told otherwise, so a
// second answer queued before that call replaces the first - each is placed at
// its own call instead. an Error is thrown from its call rather than returned
export const queue = <F extends (...args: never[]) => Promise<string>>(
  fn: Mock<F>,
  values: (string | Error)[]
) => {
  const from = fn.mock.callCount();

  values.forEach((value, index) =>
    fn.mock.mockImplementationOnce(
      (async () => {
        if (value instanceof Error) {
          throw value;
        }

        return value;
      }) as F,
      from + index
    )
  );
};
