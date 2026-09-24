import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  rmSync,
  unlinkSync
} from 'node:fs';

import { home } from './config';
import { getLogger } from './logging';
import { describeError } from '../utils';

const log = getLogger('checkpoints');
// alongside the sessions and the approval rules, under the same root
const checkpointDir = resolve(home, 'checkpoints', randomUUID());

type Checkpoint = {
  path: string;
  // where the previous contents were put, or undefined when there were none
  // because the file is one this session created
  blob?: string;
  at: number;
  // the turn that made the change, so a rewind can take back everything a
  // prompt led to and nothing before it
  turn: number;
};

// newest last, so undoing walks backwards through the session
const stack: Checkpoint[] = [];

// only ever counts up - not even discarding the checkpoints resets it - so a
// turn in the conversation now always outnumbers any in one left behind by
// /clear or /resume, and rewinding the one cannot reach into the other
let turn = 0;

export const beginTurn = () => ++turn;

// copied rather than read into memory: a session can rewrite a great many
// files, and some of them are large
export const record = (path: string) => {
  const target = resolve(path);
  const existed = existsSync(target);
  const checkpoint: Checkpoint = { path: target, at: Date.now(), turn };

  if (existed) {
    const blob = resolve(checkpointDir, `${stack.length}-${randomUUID()}`);

    try {
      mkdirSync(checkpointDir, { recursive: true });
      copyFileSync(target, blob);
      checkpoint.blob = blob;
    } catch (error) {
      // a snapshot that cannot be taken must not stop the write the user
      // already approved - it only costs the ability to undo it
      log.warn(`Could not snapshot ${target}: ${describeError(error)}`);

      return;
    }
  }

  stack.push(checkpoint);

  return checkpoint;
};

export const changes = () => {
  if (!stack.length) {
    return 'Nothing has been written this session.';
  }

  return [...stack]
    .reverse()
    .map(
      (checkpoint, index) =>
        `${String(index + 1).padStart(3)}. ${checkpoint.path}${
          checkpoint.blob ? '' : ' (created)'
        }`
    )
    .join('\n');
};

// how many changes rewinding to the given turn would take back
export const countSince = (from: number) =>
  stack.filter((checkpoint) => checkpoint.turn >= from).length;

// puts one write back the way it was. a file this session created is removed
// outright, since restoring it to nothing would leave an empty one where there
// had been none
const restore = (checkpoint: Checkpoint) => {
  if (!checkpoint.blob) {
    if (existsSync(checkpoint.path)) {
      unlinkSync(checkpoint.path);
    }

    return `Removed ${checkpoint.path}, which was created this session.`;
  }

  copyFileSync(checkpoint.blob, checkpoint.path);
  rmSync(checkpoint.blob, { force: true });

  return `Restored ${checkpoint.path}.`;
};

// takes back every change made in the given turn or since, newest first, so a
// file written twice ends up as it was before the first of them. it stops at
// the first change that cannot be put back, leaving that one on the stack: a
// restore that failed has not happened, and the next attempt should start there
export const rewind = (from: number) => {
  const restored: string[] = [];

  while (stack.length && stack[stack.length - 1].turn >= from) {
    const checkpoint = stack.pop() as Checkpoint;

    try {
      restored.push(restore(checkpoint));
    } catch (error) {
      stack.push(checkpoint);

      return {
        restored,
        failed: `Could not restore ${checkpoint.path}: ${describeError(error)}`
      };
    }
  }

  return { restored };
};

// nothing kept here outlives the session that made it
export const discardCheckpoints = () => {
  stack.length = 0;

  try {
    rmSync(checkpointDir, { recursive: true, force: true });
  } catch (error) {
    log.debug(`Could not clear ${checkpointDir}: ${describeError(error)}`);
  }
};
