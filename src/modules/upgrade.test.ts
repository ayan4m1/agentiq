import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { type Spawner, upgrade, upgradeCommand } from './upgrade';

// a child that ends however the test says, once upgrade() is listening
const fakeSpawner = (end: (child: EventEmitter) => void) =>
  mock.fn((() => {
    const child = new EventEmitter();

    setImmediate(() => end(child));

    return child;
  }) as unknown as Spawner);

describe('upgrade', () => {
  test('runs npm through the shell, printing to the terminal', async () => {
    const spawner = fakeSpawner((child) => child.emit('exit', 0));

    await upgrade(spawner);

    assert.equal(spawner.mock.callCount(), 1);
    assert.deepEqual(spawner.mock.calls[0].arguments, [
      upgradeCommand,
      { shell: true, stdio: 'inherit' }
    ]);
    assert.equal(upgradeCommand, 'npm i -g @ayan4m1/agentiq');
  });

  test('succeeds when npm does', async () => {
    assert.equal(
      await upgrade(fakeSpawner((child) => child.emit('exit', 0))),
      true
    );
  });

  test('fails when npm does', async () => {
    assert.equal(
      await upgrade(fakeSpawner((child) => child.emit('exit', 1))),
      false
    );
  });

  test('fails when npm cannot be started', async () => {
    assert.equal(
      await upgrade(
        fakeSpawner((child) => child.emit('error', new Error('spawn ENOENT')))
      ),
      false
    );
  });
});
