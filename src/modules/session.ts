import { Message } from 'ollama';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';

import { ollama, session as config } from './config';
import { getLogger } from './logging';
import { describeError } from '../utils';

const log = getLogger('session');
// alongside the tokenizer cache, which already lives under ~/.agentiq
const sessionDir = resolve(homedir(), '.agentiq', 'sessions');
const extension = '.jsonl';
// a session is identified by its first user message, so it has to be short
// enough to list and long enough to recognise
const labelLength = 60;

type Meta = {
  type: string;
  id: string;
  startedAt: string;
  model: string;
  cwd: string;
};

// one JSON object per line: the meta record first, then a record per message
type Record = {
  type: string;
  message?: Message;
};

export type SessionSummary = {
  id: string;
  label: string;
  messages: number;
  updatedAt: number;
};

let meta: Meta;
let activePath: string;
// messages already on disk, tracked the same way modules/ollama.ts tracks the
// ones it has already counted
let persisted = new WeakSet<Message>();

const pathFor = (id: string) => resolve(sessionDir, `${id}${extension}`);

const encode = (record: Meta | Record) => `${JSON.stringify(record)}\n`;

// the system prompt is rebuilt from AGENTIQ.md on every run, so persisting it
// would resume a stale copy of a file that may since have changed. leaving it
// out also means a restored history starts on a user message, which is what
// think() expects before it prepends the current prompt
const persistable = (messages: Message[]) =>
  messages.filter((message) => message.role !== 'system');

// the file is created by the first message rather than at startup, so a session
// that never went anywhere does not clutter the list
const ensureFile = () => {
  if (existsSync(activePath)) {
    return;
  }

  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(activePath, encode(meta));
};

export const startSession = () => {
  const id = randomUUID();

  meta = {
    type: 'meta',
    id,
    startedAt: new Date().toISOString(),
    model: ollama.model,
    cwd: process.cwd()
  };
  activePath = pathFor(id);
  persisted = new WeakSet<Message>();

  return id;
};

// appends whatever is not on disk yet. a failure here must not cost the turn -
// losing the transcript is bad, losing the conversation is worse
export const append = (messages: Message[]) => {
  const fresh = persistable(messages).filter(
    (message) => !persisted.has(message)
  );

  if (!fresh.length) {
    return;
  }

  try {
    ensureFile();
    appendFileSync(
      activePath,
      fresh.map((message) => encode({ type: 'message', message })).join('')
    );

    for (const message of fresh) {
      persisted.add(message);
    }
  } catch (error) {
    log.warn(`Could not write to the session file: ${describeError(error)}`);
  }
};

// compaction replaces the message objects outright, so there is nothing to
// append to - the file has to be written again from what is left
export const rewrite = (messages: Message[]) => {
  const kept = persistable(messages);

  try {
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      activePath,
      [
        encode(meta),
        ...kept.map((message) => encode({ type: 'message', message }))
      ].join('')
    );

    persisted = new WeakSet<Message>();

    for (const message of kept) {
      persisted.add(message);
    }
  } catch (error) {
    log.warn(`Could not rewrite the session file: ${describeError(error)}`);
  }
};

// a line that will not parse is one turn of one session, and refusing to open
// the file over it would lose all the others
const readRecords = (path: string) => {
  const records: Record[] = [];

  for (const line of readFileSync(path).toString().split('\n')) {
    if (!line.trim()) {
      continue;
    }

    try {
      records.push(JSON.parse(line));
    } catch {
      log.warn(`Skipping a malformed line in ${path}`);
    }
  }

  return records;
};

const summarize = (path: string, id: string): SessionSummary => {
  const records = readRecords(path);
  const messages = records.filter((record) => record.type === 'message');
  const first = messages.find((record) => record.message?.role === 'user');
  const label = (first?.message?.content ?? '(no messages)')
    .replace(/\s+/g, ' ')
    .trim();

  return {
    id,
    label:
      label.length > labelLength ? `${label.slice(0, labelLength)}…` : label,
    messages: messages.length,
    updatedAt: statSync(path).mtimeMs
  };
};

// newest first, going by mtime alone - cheap enough to run over every file
// without parsing any of them
const sessionFiles = () => {
  if (!existsSync(sessionDir)) {
    return [];
  }

  const files: { id: string; path: string; updatedAt: number }[] = [];

  for (const file of readdirSync(sessionDir)) {
    if (!file.endsWith(extension)) {
      continue;
    }

    const path = resolve(sessionDir, file);

    try {
      files.push({
        id: file.slice(0, -extension.length),
        path,
        updatedAt: statSync(path).mtimeMs
      });
    } catch (error) {
      log.warn(`Could not read ${path}: ${describeError(error)}`);
    }
  }

  return files.sort((left, right) => right.updatedAt - left.updatedAt);
};

export const listSessions = (limit = 10) => {
  const summaries: SessionSummary[] = [];

  for (const { id, path } of sessionFiles()) {
    if (summaries.length >= limit) {
      break;
    }

    try {
      summaries.push(summarize(path, id));
    } catch (error) {
      log.warn(`Could not read ${path}: ${describeError(error)}`);
    }
  }

  return summaries;
};

// runs before a session is started or resumed, so a --resume that names a
// pruned session fails the same way one that never existed does
export const pruneSessions = () => {
  if (!Number.isFinite(config.limit) || config.limit <= 0) {
    return;
  }

  for (const { path } of sessionFiles().slice(config.limit)) {
    try {
      unlinkSync(path);
    } catch (error) {
      log.warn(`Could not delete ${path}: ${describeError(error)}`);
    }
  }
};

// picks up an earlier session and keeps writing to the same file, so resuming
// twice does not scatter one conversation across three of them
export const loadSession = (id: string) => {
  const path = pathFor(id);

  if (!existsSync(path)) {
    return;
  }

  const records = readRecords(path);
  const found = records.find((record) => record.type === 'meta') as Meta;
  const messages = records
    .filter((record) => record.type === 'message' && record.message)
    .map((record) => record.message as Message);

  meta = found ?? {
    type: 'meta',
    id,
    startedAt: new Date().toISOString(),
    model: ollama.model,
    cwd: process.cwd()
  };
  activePath = path;
  persisted = new WeakSet<Message>();

  for (const message of messages) {
    persisted.add(message);
  }

  return messages;
};
