import { fileURLToPath } from 'url';
import { program } from 'commander';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const commandDir = resolve(__dirname, 'commands');

await program
  .name('agentiq')
  .executableDir(commandDir)
  .description('Upgrade dependencies')
  .command('run', 'Start the service in the foreground', {
    isDefault: true,
    executableFile: 'run.js'
  })
  .parseAsync();
