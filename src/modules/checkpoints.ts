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
};

// newest last, so undoing walks backwards through the session
const stack: Checkpoint[] = [];

// copied rather than read into memory: a session can rewrite a great many
// files, and some of them are large
export const record = (path: string) => {
  const target = resolve(path);
  const existed = existsSync(target);
  const checkpoint: Checkpoint = { path: target, at: Date.now() };

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

// puts the most recent write back the way it was. a file this session created
// is removed outright, since restoring it to nothing would leave an empty one
// where there had been none
export const undo = () => {
  const checkpoint = stack.pop();

  if (!checkpoint) {
    return 'There is nothing to undo - nothing has been written this session.';
  }

  try {
    if (!checkpoint.blob) {
      if (existsSync(checkpoint.path)) {
        unlinkSync(checkpoint.path);
      }

      return `Removed ${checkpoint.path}, which was created this session.`;
    }

    copyFileSync(checkpoint.blob, checkpoint.path);
    rmSync(checkpoint.blob, { force: true });

    return `Restored ${checkpoint.path} to what it was before the last change.`;
  } catch (error) {
    // put it back on the stack: an undo that failed has not happened, and the
    // next attempt should be about the same change
    stack.push(checkpoint);

    return `Could not undo ${checkpoint.path}: ${describeError(error)}`;
  }
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
