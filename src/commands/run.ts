import { program } from 'commander';

import { startRepl } from '../modules/interactive';

// commander runs this file as its own executable, so the options it was given
// arrive here rather than in src/index.ts - the supported spelling is
// `agentiq run --resume`, since the parent program owns the bare argv
const { resume } = program
  .allowUnknownOption()
  .allowExcessArguments()
  .option('--resume [id]', 'resume the most recent session, or one by id')
  .parse(process.argv)
  .opts();

await startRepl({ resume });
