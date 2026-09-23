// node --import target: installs the resolver for the test process and every
// worker the test runner spawns. registerHooks takes the hook functions
// themselves - a module specifier is what register() takes instead
import { mkdtempSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { resolve as resolvePath } from 'node:path';

import { resolve } from './hooks.mjs';

registerHooks({ resolve });

// modules/config.ts seeds config.yml under AQ_HOME the moment it is imported.
// a test file that sets its own AQ_HOME still wins, since it does so before
// importing config - this only keeps the rest away from the real ~/.agentiq
process.env.AQ_HOME ||= mkdtempSync(resolvePath(tmpdir(), 'agentiq-test-'));
