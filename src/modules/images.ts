import { execFile } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { extname } from 'node:path';
import { promisify } from 'node:util';

// what @ attaches as an image rather than as text. every provider takes these
// three, which is not true of gif or anything rarer
export const imageExtensions = ['.png', '.jpg', '.jpeg', '.webp'];

export const isImagePath = (path: string) =>
  imageExtensions.includes(extname(path).toLowerCase());

// the most the Anthropic API takes for one image. refused up front, since the
// alternative is a turn that fails only after the user has waited for it
export const maxImageBytes = 5 * 1024 * 1024;

// an image's real cost depends on its size and on who is reading it, which
// nothing here knows - so it is guessed at, and the provider's count of the
// prompt corrects it once there is one, as it does for text
export const imageTokenEstimate = 1500;

// images are kept as bare base64, which is what ollama takes and what a session
// file can hold. a provider that wants a media type reads it off the bytes,
// so nothing more has to be kept beside each one
export const mediaTypeOf = (base64: string) => {
  const head = Buffer.from(base64.slice(0, 24), 'base64');

  if (head.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) {
    return 'image/png';
  }

  if (head.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) {
    return 'image/jpeg';
  }

  if (
    head.subarray(0, 4).toString('latin1') === 'RIFF' &&
    head.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'image/webp';
  }

  if (head.subarray(0, 4).toString('latin1') === 'GIF8') {
    return 'image/gif';
  }

  // the commonest kind, and what a clipboard always hands over
  return 'image/png';
};

const describeSize = (bytes: number) =>
  `${(bytes / 1024 / 1024).toFixed(1)} MB`;

// the file as base64, or why it cannot be sent
export const readImage = (
  path: string
): { image: string } | { error: string } => {
  const { size } = statSync(path);

  if (size > maxImageBytes) {
    return {
      error: `${path} is ${describeSize(size)}, over the ${describeSize(maxImageBytes)} an image can be`
    };
  }

  return { image: readFileSync(path).toString('base64') };
};

// runs a program and hands back what it wrote, as bytes - wl-paste and xclip
// write the image itself, which would not survive being decoded as text
export type Runner = (file: string, args: string[]) => Promise<Buffer>;

const run: Runner = async (file, args) => {
  const { stdout } = await promisify(execFile)(file, args, {
    encoding: 'buffer',
    // a screenshot of a large display is several megabytes, and twice that
    // once it is written out as hex or base64
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true
  });

  return stdout;
};

// a clipboard image is a bitmap until something writes it out, so it is saved
// as a png and printed as base64. clipboard access needs a single-threaded
// apartment, which -STA asks for explicitly
const windowsScript = [
  'Add-Type -AssemblyName System.Windows.Forms, System.Drawing',
  '$image = [System.Windows.Forms.Clipboard]::GetImage()',
  'if ($image) {',
  '  $stream = New-Object System.IO.MemoryStream',
  '  $image.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)',
  '  [Convert]::ToBase64String($stream.ToArray())',
  '}'
].join('\n');

// what is tried on each platform, in order, and how its output becomes base64.
// the first to give back an image wins
type Reader = {
  file: string;
  args: string[];
  decode: (output: Buffer) => string | undefined;
};

const asBase64 = (output: Buffer) =>
  output.length ? output.toString('base64') : undefined;

const readers: Partial<Record<NodeJS.Platform, Reader[]>> = {
  win32: [
    {
      file: 'powershell.exe',
      args: [
        '-NoProfile',
        '-NonInteractive',
        '-STA',
        '-Command',
        windowsScript
      ],
      decode: (output) => output.toString('utf8').trim() || undefined
    }
  ],
  // applescript prints the bytes as «data PNGf89504E47…»
  darwin: [
    {
      file: 'osascript',
      args: ['-e', 'the clipboard as «class PNGf»'],
      decode: (output) => {
        const hex = output.toString('utf8').match(/«data PNGf([0-9A-Fa-f]+)»/);

        return hex ? Buffer.from(hex[1], 'hex').toString('base64') : undefined;
      }
    }
  ],
  // wayland first, since an X tool on a wayland session sees only what X
  // clients put on the clipboard
  linux: [
    {
      file: 'wl-paste',
      args: ['--no-newline', '--type', 'image/png'],
      decode: asBase64
    },
    {
      file: 'xclip',
      args: ['-selection', 'clipboard', '-t', 'image/png', '-o'],
      decode: asBase64
    }
  ]
};

// the programs a clipboard is read with here, for saying what was tried
export const clipboardTools = (platform = process.platform) =>
  (readers[platform] ?? []).map(({ file }) => file);

// the image on the clipboard as base64, or undefined when there is none - or
// when nothing that could read it is installed, which looks the same to anyone
// asking. a program that fails is passed over for the next one
export const readClipboardImage = async (
  runner: Runner = run,
  platform = process.platform
) => {
  for (const { file, args, decode } of readers[platform] ?? []) {
    try {
      const image = decode(await runner(file, args));

      if (image) {
        return image;
      }
    } catch {
      // not installed, or nothing on the clipboard it could read
    }
  }

  return undefined;
};
