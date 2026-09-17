import { ChildProcess, execFileSync, spawn } from 'node:child_process';

import { shell } from './config';
import { getLogger } from './logging';

const log = getLogger('process');
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
