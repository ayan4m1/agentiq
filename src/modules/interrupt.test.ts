import { test, describe, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { watchForInterrupt } from './interrupt';

// just enough of a tty stream for the watcher, including the internals it has
// to reach into to stop a read on a paused stream
class FakeStdin extends EventEmitter {
  isTTY = true;
  isRaw = false;
  paused = true;
  _handle = { reading: true, readStop: mock.fn(() => 0) };
  _readableState = { reading: true };

  setRawMode = mock.fn((raw: boolean) => {
    this.isRaw = raw;

    return this;
  });

  isPaused() {
    return this.paused;
  }

  pause() {
    this.paused = true;

    return this;
  }

  resume() {
    this.paused = false;

    return this;
  }
}

let stdin: FakeStdin;

// process.stdin is a lazy getter, which mock.property cannot stand in for
const original = Object.getOwnPropertyDescriptor(process, 'stdin')!;

const press = (...bytes: number[]) => stdin.emit('data', Buffer.from(bytes));

beforeEach(() => {
  stdin = new FakeStdin();
  Object.defineProperty(process, 'stdin', {
    configurable: true,
    get: () => stdin
  });
});

afterEach(() => {
  Object.defineProperty(process, 'stdin', original);
  mock.restoreAll();
});

describe('watchForInterrupt', () => {
  test('does nothing when input is not a terminal', () => {
    stdin.isTTY = false;

    const stop = watchForInterrupt(() => {});

    stop();

    assert.equal(stdin.setRawMode.mock.callCount(), 0);
    assert.equal(stdin.listenerCount('data'), 0);
  });

  test('reads keys raw from a resumed stream', () => {
    watchForInterrupt(() => {});

    assert.equal(stdin.isRaw, true);
    assert.equal(stdin.paused, false);
    assert.equal(stdin.listenerCount('data'), 1);
  });

  test('interrupts on a lone escape', () => {
    const onInterrupt = mock.fn();

    watchForInterrupt(onInterrupt);
    press(0x1b);

    assert.equal(onInterrupt.mock.callCount(), 1);
  });

  test('ignores a key sequence that merely starts with escape', () => {
    const onInterrupt = mock.fn();

    watchForInterrupt(onInterrupt);
    // the up arrow
    press(0x1b, 0x5b, 0x41);

    assert.equal(onInterrupt.mock.callCount(), 0);
  });

  test('ignores ordinary keys', () => {
    const onInterrupt = mock.fn();

    watchForInterrupt(onInterrupt);
    press(0x61);

    assert.equal(onInterrupt.mock.callCount(), 0);
  });

  test('raises SIGINT by hand for ^C, from a cooked terminal', () => {
    const kill = mock.method(process, 'kill', () => true);

    watchForInterrupt(() => {});
    press(0x03);

    assert.deepEqual(kill.mock.calls[0].arguments, [process.pid, 'SIGINT']);
    assert.equal(stdin.isRaw, false);
    assert.equal(stdin.listenerCount('data'), 0);
  });

  test('hands the terminal back as it found it', () => {
    const stop = watchForInterrupt(() => {});

    stop();

    assert.equal(stdin.isRaw, false);
    assert.equal(stdin.paused, true);
    assert.equal(stdin.listenerCount('data'), 0);
  });

  test('stops the read under a stream it pauses again', () => {
    // a paused stream whose handle is still reading keeps windows consoles in
    // cooked mode and swallows keys meant for the next prompt
    const stop = watchForInterrupt(() => {});

    stop();

    assert.equal(stdin._handle.readStop.mock.callCount(), 1);
    assert.equal(stdin._handle.reading, false);
    assert.equal(stdin._readableState.reading, false);
  });

  test('leaves a stream running that was running beforehand', () => {
    stdin.paused = false;

    const stop = watchForInterrupt(() => {});

    stop();

    assert.equal(stdin.paused, false);
    assert.equal(stdin._handle.readStop.mock.callCount(), 0);
  });

  test('leaves a terminal raw that was raw beforehand', () => {
    stdin.isRaw = true;

    const stop = watchForInterrupt(() => {});

    stop();

    assert.equal(stdin.isRaw, true);
    // it was raw already, so there was nothing to put back
    assert.equal(stdin.setRawMode.mock.callCount(), 1);
  });

  test('only stops once', () => {
    const stop = watchForInterrupt(() => {});

    stop();
    stop();

    assert.equal(stdin._handle.readStop.mock.callCount(), 1);
    assert.equal(stdin.setRawMode.mock.callCount(), 2);
  });
});
