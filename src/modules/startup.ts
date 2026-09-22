import Bottleneck from 'bottleneck';

import { ollama } from './config';
import { killAllJobs } from './jobs';
import { makeThinker } from './ollama';
import { preflight } from './preflight';
import { ensureTokenizer } from './tokenizer';
import { resolveStartupEntry } from './models';
import { discardCheckpoints } from './checkpoints';
import type { ThoughtState } from '../types';

// everything both commands do before the first turn. a failure has already
// been reported by whatever failed, so the caller only has to exit - the
// process is the command's to end, not this module's
export const startAgent = async () => {
  // which model, and which tokenizer goes with it, comes from
  // ~/.agentiq/models.json rather than the environment - so it has to be read
  // before anything asks the config what it is talking to
  if (!(await resolveStartupEntry())) {
    return;
  }

  // a missing model or an unreachable host is worth saying now rather than
  // after the first message - and before the tokenizer download, which is the
  // slow part of starting up
  if (!(await preflight())) {
    return;
  }

  // makeThinker() tokenizes the system prompt and every tool definition up
  // front, so the tokenizer has to be on disk before it runs
  await ensureTokenizer();

  const thinker = makeThinker();
  // maxConcurrent is what matters here: turns must not overlap. minTime is for
  // a metered remote endpoint and is zero by default
  const rateLimiter = new Bottleneck({
    maxConcurrent: 1,
    minTime: ollama.minTurnDelay
  });
  const schedule = (work: () => Promise<ThoughtState>) =>
    rateLimiter.schedule(work);

  // a dev server that outlives the session holds its port and is only noticed
  // much later, so every exit path calls killAllJobs first. snapshots are the
  // same: they only exist for the scope of this session.
  const cleanUp = () => {
    killAllJobs();
    discardCheckpoints();
  };

  process.on('exit', cleanUp);
  // ^C during generation is raised as a signal by modules/interrupt.ts, and
  // listening for it replaces the default termination - so exit deliberately
  process.on('SIGINT', () => {
    cleanUp();
    process.exit(130);
  });

  return { thinker, schedule, cleanUp };
};
