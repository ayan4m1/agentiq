import { ChildProcess } from 'node:child_process';

import { getLogger } from './logging';
import { killTree, spawnCommand } from './process';
import { getContentBudget } from '../utils';

const log = getLogger('jobs');
// a watch build left running all session would otherwise grow without bound,
// and it is the end of its output that says what went wrong
const bufferLimit = getContentBudget(0.2);

type JobStatus = 'running' | 'exited' | 'killed' | 'failed';

type Job = {
  id: number;
  command: string;
  cwd: string;
  child: ChildProcess;
  status: JobStatus;
  code?: number;
  error?: string;
  startedAt: number;
  // everything the job has produced that has not yet been dropped, plus how
  // far into it the model has already read
  buffer: string;
  cursor: number;
  dropped: number;
};

const jobs = new Map<number, Job>();
let nextId = 1;

const describeStatus = (job: Job) => {
  switch (job.status) {
    case 'running':
      return `running for ${Math.round((Date.now() - job.startedAt) / 1000)}s`;
    case 'exited':
      return `exited with code ${job.code ?? 0}`;
    case 'failed':
      return `failed to start: ${job.error}`;
    default:
      return 'stopped';
  }
};

const missing = (id: number) => {
  const known = [...jobs.keys()];

  return known.length
    ? `There is no job ${id}. Current jobs: ${known.join(', ')}`
    : `There is no job ${id} - no background jobs have been started.`;
};

// keep the tail rather than the head, and remember how much went, so the model
// is never quietly shown a gap. the job is looked up rather than captured -
// output starts arriving only after startJob has registered it
const record = (id: number, chunk: string) => {
  const job = jobs.get(id);

  if (!job) {
    return;
  }

  job.buffer += chunk;

  if (job.buffer.length <= bufferLimit) {
    return;
  }

  const excess = job.buffer.length - bufferLimit;

  job.buffer = job.buffer.slice(excess);
  job.dropped += excess;
  job.cursor = Math.max(job.cursor - excess, 0);
};

export const startJob = (command: string, cwd: string) => {
  const id = nextId++;
  const { child, finished } = spawnCommand({
    command,
    cwd,
    onData: (chunk) => record(id, chunk)
  });
  const job: Job = {
    id,
    command,
    cwd,
    child,
    status: 'running',
    startedAt: Date.now(),
    buffer: '',
    cursor: 0,
    dropped: 0
  };

  jobs.set(id, job);

  finished.then((outcome) => {
    if (outcome.error) {
      job.status = 'failed';
      job.error = outcome.error;
    } else if (job.status === 'running') {
      job.status = 'exited';
      job.code = outcome.code;
    }

    log.debug(`Job ${id} ${describeStatus(job)}`);
  });

  log.info(`Started job ${id}: ${command}`);

  return id;
};

// output since the last read, so polling a job is cheap rather than replaying
// everything it has ever printed
export const readJob = (id: number) => {
  const job = jobs.get(id);

  if (!job) {
    return missing(id);
  }

  const fresh = job.buffer.slice(job.cursor);
  const dropped = job.dropped;
  const header = `Job ${id} [${describeStatus(job)}] ${job.command}`;

  job.cursor = job.buffer.length;
  job.dropped = 0;

  if (!fresh) {
    return `${header}\n\n[no new output]`;
  }

  return [
    header,
    '',
    dropped ? `[${dropped} earlier characters dropped]` : '',
    fresh
  ]
    .filter(Boolean)
    .join('\n');
};

export const listJobs = () => {
  if (!jobs.size) {
    return 'No background jobs have been started.';
  }

  return [...jobs.values()]
    .map((job) => `${job.id} [${describeStatus(job)}] ${job.command}`)
    .join('\n');
};

export const stopJob = (id: number) => {
  const job = jobs.get(id);

  if (!job) {
    return missing(id);
  }

  if (job.status !== 'running') {
    return `Job ${id} is not running - it ${describeStatus(job)}.`;
  }

  killTree(job.child);
  job.status = 'killed';
  log.info(`Stopped job ${id}`);

  return `Stopped job ${id} (${job.command}).`;
};

// nothing we started should outlive the session - a dev server holding a port
// is the kind of mess that is only noticed much later
export const killAllJobs = () => {
  for (const job of jobs.values()) {
    if (job.status === 'running') {
      killTree(job.child);
      job.status = 'killed';
    }
  }
};
