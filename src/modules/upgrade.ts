import chalk from 'chalk';
import { spawn } from 'node:child_process';

import { getLogger } from './logging';
import { describeError } from '../utils';

const log = getLogger('upgrade');

export const upgradeCommand = 'npm i -g @ayan4m1/agentiq';

// starts a command and hands back the child, which a test stands in for
export type Spawner = typeof spawn;

// installs the latest release over this one. npm prints straight to the
// terminal, since its progress and errors are what the user wants to see. the
// shell is needed on Windows, where npm is npm.cmd and cannot be spawned bare
export const upgrade = (spawner: Spawner = spawn) =>
  new Promise<boolean>((done) => {
    const child = spawner(upgradeCommand, { shell: true, stdio: 'inherit' });

    child.once('error', (error) => {
      log.error(
        chalk.red(`Could not run ${upgradeCommand}: ${describeError(error)}`)
      );
      done(false);
    });

    child.once('exit', (code) => {
      if (code === 0) {
        // the code already loaded is what keeps running until a restart
        log.info(
          chalk.green('Upgraded agentiq - restart it to use the new version')
        );
        done(true);
      } else {
        log.error(chalk.red(`Upgrade failed (exit code ${code})`));
        done(false);
      }
    });
  });
