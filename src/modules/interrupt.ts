const noop = () => {};

// a lone escape is the interrupt - arrow keys and the like arrive as longer
// sequences that merely start with one
const escape = 0x1b;
const endOfText = 0x03;

// the libuv handle behind a tty stream, and the stream's own record of whether
// it asked that handle for data - node has no public way to stop the read
// without also destroying the stream, and the two have to be stopped together
type InternalStdin = {
  _handle?: {
    reading: boolean;
    readStop: () => number;
  };
  _readableState: {
    reading: boolean;
  };
};

// nothing owns stdin while the model streams - inquirer builds a readline per
// prompt and closes it again - so escape has to be watched for directly. the
// bytes are read raw rather than through emitKeypressEvents: readline's keypress
// pump tears itself off stdin the moment data arrives with no keypress listeners
// left, and adding one per turn only to take it away again is what kills it
export const watchForInterrupt = (onInterrupt: () => void) => {
  const { stdin } = process;

  // piped input has no keys to watch, and setRawMode does not exist on it
  if (!stdin.isTTY) {
    return noop;
  }

  const wasRaw = stdin.isRaw;
  const wasPaused = stdin.isPaused();
  let watching = true;

  const stop = () => {
    if (!watching) {
      return;
    }

    watching = false;
    stdin.off('data', onData);

    // hand the terminal back exactly as it was found - the prompt that comes
    // next sets up its own mode, and undoing more than we did breaks it.
    // the read has to stop before the mode changes: pause() alone leaves the
    // handle reading, and on windows libuv re-queues a live read in whatever
    // mode it finds - a cooked ReadConsole that swallows every key until enter
    if (wasPaused) {
      stdin.pause();

      const internal = stdin as unknown as InternalStdin;
      const handle = internal._handle;

      // the same thing node does itself when a paused stream refuses a push.
      // the stream's flag is normally cleared by the push itself, and none has
      // happened - left set, the next resume() believes a read is already under
      // way and never restarts the handle, so the event loop drains and the
      // process exits mid-prompt
      if (handle?.reading) {
        handle.reading = false;
        handle.readStop();
        internal._readableState.reading = false;
      }
    }

    if (stdin.isRaw !== wasRaw) {
      stdin.setRawMode(wasRaw);
    }
  };

  function onData(chunk: Buffer) {
    if (chunk.length === 1 && chunk[0] === escape) {
      onInterrupt();
    } else if (chunk.includes(endOfText)) {
      // raw mode clears ISIG, so the terminal no longer turns ^C into a signal
      // and the process would be unkillable mid-stream. raise it by hand, from
      // a cooked terminal, rather than inventing an exit of our own
      stop();
      process.kill(process.pid, 'SIGINT');
    }

    // everything else is dropped rather than buffered into the next prompt
  }

  stdin.setRawMode(true);
  stdin.on('data', onData);
  // the prompt that just closed its readline paused stdin, and a data listener
  // does not restart a stream that was explicitly paused - without this the
  // escape byte is never delivered
  stdin.resume();

  return stop;
};
