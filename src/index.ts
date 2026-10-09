#!/usr/bin/env node

import { fileURLToPath } from 'url';
import { program } from 'commander';
import { dirname, resolve } from 'path';
import { readFileSync } from 'fs';

import type { PackageJson } from './types';

const __dirname = dirname(fileURLToPath(import.meta.url));
const commandDir = resolve(__dirname, 'commands');
const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8')
) as PackageJson;

await program
  .name(packageJson.name)
  .version(packageJson.version)
  .description(packageJson.description)
  .executableDir(commandDir)
  .command('run', 'Start the service in the foreground', {
    isDefault: true,
    executableFile: 'run.js'
  })
  .command('exec', 'Run a single prompt without interaction', {
    executableFile: 'exec.js'
  })
  .parseAsync();
