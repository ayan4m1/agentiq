import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import {
  clipboardTools,
  isImagePath,
  maxImageBytes,
  mediaTypeOf,
  readClipboardImage,
  readImage,
  type Runner
} from './images';

const bytes = (...values: number[]) => Buffer.from(values).toString('base64');
const png = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

describe('isImagePath', () => {
  test('takes the extensions every provider can be shown, in any case', () => {
    for (const path of ['a.png', 'b.jpg', 'c.jpeg', 'd.webp', 'shot.PNG']) {
      assert.equal(isImagePath(path), true, path);
    }
  });

  test('leaves everything else to be read as text', () => {
    for (const path of ['a.gif', 'b.svg', 'notes.txt', 'png']) {
      assert.equal(isImagePath(path), false, path);
    }
  });
});

describe('mediaTypeOf', () => {
  test('reads the type off the first bytes', () => {
    assert.equal(mediaTypeOf(png), 'image/png');
    assert.equal(mediaTypeOf(bytes(0xff, 0xd8, 0xff, 0xe0)), 'image/jpeg');
    assert.equal(
      mediaTypeOf(Buffer.from('RIFF\0\0\0\0WEBPVP8 ').toString('base64')),
      'image/webp'
    );
    assert.equal(
      mediaTypeOf(Buffer.from('GIF89a').toString('base64')),
      'image/gif'
    );
  });

  test('takes anything it does not recognise for a png', () => {
    assert.equal(mediaTypeOf(bytes(1, 2, 3, 4)), 'image/png');
  });
});

describe('readImage', () => {
  let root: string;

  before(() => {
    root = mkdtempSync(resolve(tmpdir(), 'agentiq-images-'));
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('reads the file as base64', () => {
    const path = resolve(root, 'shot.png');

    writeFileSync(path, Buffer.from(png, 'base64'));

    assert.deepEqual(readImage(path), { image: png });
  });

  test('refuses a file too large to be sent', () => {
    const path = resolve(root, 'huge.png');

    writeFileSync(path, Buffer.alloc(maxImageBytes + 1));

    const read = readImage(path);

    assert.ok('error' in read);
    assert.match(read.error, /huge\.png is 5\.0 MB, over the 5\.0 MB/);
  });
});

describe('readClipboardImage', () => {
  // answers each program with what the test says, and notes what was run
  const runner = (answers: Record<string, Buffer | Error>) => {
    const ran: string[] = [];
    const run: Runner = async (file) => {
      ran.push(file);

      const answer = answers[file];

      if (!answer || answer instanceof Error) {
        throw answer ?? new Error(`spawn ${file} ENOENT`);
      }

      return answer;
    };

    return { run, ran };
  };

  test('takes the base64 powershell prints on windows', async () => {
    const { run } = runner({
      'powershell.exe': Buffer.from(`${png}\r\n`)
    });

    assert.equal(await readClipboardImage(run, 'win32'), png);
  });

  test('decodes the hex applescript prints on macOS', async () => {
    const { run } = runner({
      osascript: Buffer.from('«data PNGf89504E470D0A1A0A»\n')
    });

    assert.equal(await readClipboardImage(run, 'darwin'), png);
  });

  test('falls back from wl-paste to xclip on linux', async () => {
    const { run, ran } = runner({
      xclip: Buffer.from(png, 'base64')
    });

    assert.equal(await readClipboardImage(run, 'linux'), png);
    assert.deepEqual(ran, ['wl-paste', 'xclip']);
  });

  test('finds nothing when the clipboard holds no image', async () => {
    const { run } = runner({
      'powershell.exe': Buffer.from('\r\n'),
      osascript: new Error('Can’t make some data into the expected type.')
    });

    assert.equal(await readClipboardImage(run, 'win32'), undefined);
    assert.equal(await readClipboardImage(run, 'darwin'), undefined);
    assert.equal(await readClipboardImage(run, 'linux'), undefined);
  });

  test('runs nothing on a platform it cannot read the clipboard on', async () => {
    const { run, ran } = runner({});

    assert.equal(await readClipboardImage(run, 'aix'), undefined);
    assert.deepEqual(ran, []);
    assert.deepEqual(clipboardTools('aix'), []);
  });

  test('names what it reads the clipboard with', () => {
    assert.deepEqual(clipboardTools('linux'), ['wl-paste', 'xclip']);
  });
});
