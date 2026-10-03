import Bottleneck from 'bottleneck';

import { ollama, provider } from './config';
import { killAllJobs } from './jobs';
import { makeThinker } from './thinker';
import { getLogger } from './logging';
import { preflight } from './preflight';
import { loadSkills } from './skills';
import { chatProvider } from '../providers';
import { ensureTokenizer, usesHfTokenizer } from './tokenizer';
import { resolveStartupEntry } from './models';
import { discardCheckpoints } from './checkpoints';
import { Provider, type ThoughtState } from '../types';

const log = getLogger('startup');

// everything both commands do before the first turn. a failure has already
// been reported by whatever failed, so the caller only has to exit - the
// process is the command's to end, not this module's
export const startAgent = async () => {
  // which model, and which tokenizer goes with it, comes from
  // ~/.agentiq/models.yml rather than the environment - so it has to be read
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

  // an unset host is the client's own default, so say which one that is
  log.info(
    `Connected to ${
      provider.name === Provider.Ollama
        ? `ollama server ${ollama.host ?? 'http://127.0.0.1:11434'}`
        : chatProvider.label
    } using model ${provider.model}`
  );

  // makeThinker() tokenizes the system prompt and every tool definition up
  // front, so the tokenizer has to be on disk before it runs
  if (usesHfTokenizer()) {
    await ensureTokenizer();
  }

  // read once here, so a malformed skill is reported before the first prompt
  // rather than in the middle of it
  loadSkills();

  const thinker = makeThinker();

  // the system prompt and tools are a sizeable share of a small window, and
  // a provider that can count them exactly is asked to before the first turn
  await thinker.count([]);
  // maxConcurrent is what matters here: turns must not overlap. minTime is for
  // a metered remote endpoint and is zero by default
  const rateLimiter = new Bottleneck({
    maxConcurrent: 1,
    minTime: provider.minTurnDelay
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
