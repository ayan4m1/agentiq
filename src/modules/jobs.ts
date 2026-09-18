import { ChildProcess, execFileSync, spawn } from 'node:child_process';

import { shell } from './config';
import { getLogger } from './logging';
import { commandOutputBudget } from '../utils';

const log = getLogger('jobs');
// a watch build left running all session would otherwise grow without bound,
// and it is the end of its output that says what went wrong
// how long a process gets to honour SIGTERM before it is taken out
const graceMs = 2000;

export type SpawnRequest = {
  command: string;
  cwd: string;
  onData: (chunk: string) => void;
};

export type Outcome = {
  code?: number;
  signal?: string;
  // set when the process could not be started at all, e.g. a cwd that is not
  // there - distinct from a command that ran and failed
  error?: string;
};

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

  if (job.buffer.length <= commandOutputBudget) {
    return;
  }

  const excess = job.buffer.length - commandOutputBudget;

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

// the one place a command becomes a process. the string is handed to a shell
// rather than parsed here, so what runs is exactly what the user approved
export const spawnCommand = ({ command, cwd, onData }: SpawnRequest) => {
  const child = spawn(command, {
    cwd,
    // undefined would mean "no shell at all" rather than the platform default,
    // so fall back to true and let node pick cmd.exe or /bin/sh
    shell: shell.path ?? true,
    windowsHide: true
  });

  child.stdout?.setEncoding('utf-8');
  child.stderr?.setEncoding('utf-8');
  // stderr is interleaved with stdout rather than kept apart: a build's errors
  // only make sense in the order they happened relative to its output
  child.stdout?.on('data', onData);
  child.stderr?.on('data', onData);

  const finished = new Promise<Outcome>((resolve) => {
    child.once('error', (error) => resolve({ error: error.message }));
    child.once('close', (code, signal) =>
      resolve({ code: code ?? undefined, signal: signal ?? undefined })
    );
  });

  return { child, finished };
};

// killing the child kills the shell, and on Windows that leaves whatever the
// shell started running with no parent - the whole tree has to go
export const killTree = (child: ChildProcess) => {
  if (!child.pid || child.exitCode !== null || child.signalCode) {
    return;
  }

  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
        stdio: 'ignore'
      });
    } catch {
      // taskkill fails when the tree is already gone, which is the outcome we
      // were after anyway
      log.debug(`taskkill could not stop pid ${child.pid}`);
    }

    return;
  }

  child.kill('SIGTERM');

  // a process that ignores SIGTERM would otherwise hold a job open forever
  setTimeout(() => {
    if (child.exitCode === null) {
      child.kill('SIGKILL');
    }
  }, graceMs).unref();
};
