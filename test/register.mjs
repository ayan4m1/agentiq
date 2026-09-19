// node --import target: installs the resolver for the test process and every
// worker the test runner spawns. registerHooks takes the hook functions
// themselves - a module specifier is what register() takes instead
import { registerHooks } from 'node:module';

import { resolve } from './hooks.mjs';

registerHooks({ resolve });
