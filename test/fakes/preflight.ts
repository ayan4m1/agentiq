import { mock } from 'node:test';

import type { ModuleMock } from './module';

type Preflight = typeof import('../../src/modules/preflight');

// preflight asks the server what the model is and what it can do, which does
// not belong in a unit test - so every answer is a plain one, a model that is
// there and can do nothing special, unless the test passes in its own
export const fakePreflight = <O extends ModuleMock<Preflight>>(
  overrides: O = {} as O
) => {
  const exports = {
    preflight: mock.fn(async () => true),
    listModels: mock.fn(async () => []),
    matchesModel: (installed: string, configured: string) =>
      installed === configured,
    supportsThinking: () => false,
    resolveThink: (): boolean | undefined => undefined,
    modelContextLength: (): number | undefined => undefined,
    readContextLength: (): number | undefined => undefined,
    ...overrides
  } satisfies ModuleMock<Preflight>;

  return { exports, ...exports };
};
