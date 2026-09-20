// must come first - it populates process.env for every read below
import './env';

import { homedir } from 'node:os';
import { resolve } from 'node:path';

import {
  type ApprovalConfig,
  ApprovalMode,
  ThinkLevel,
  type ThinkSetting,
  type LoggingConfig,
  LogLevel,
  type OllamaConfig,
  type SessionConfig,
  type ShellConfig,
  type TokenizerConfig
} from '../types';

const truthy = ['true', 'yes', '1'];
const falsy = ['false', 'no', '0'];

// an unrecognised level is not rejected by winston - it silently fails every
// comparison, so nothing is logged at all. fall back rather than go quiet.
// exported, as toThink is, because the parsing rule is what is worth checking
export const toLogLevel = (value?: string) => {
  if (!value) {
    return LogLevel.Info;
  }

  const levels = Object.values(LogLevel);
  const found = levels.find((level) => level === value);

  if (!found) {
    console.warn(
      `Ignoring AQ_LOG_LEVEL "${value}" - expected one of ${levels.join(', ')}`
    );

    return LogLevel.Info;
  }

  return found;
};

// everything agentiq keeps between runs - sessions, tokenizer caches - lives
// under here. it is overridable so a test run cannot reach the real one, and
// so a user can move the whole lot off their home directory
export const home = process.env.AQ_HOME || resolve(homedir(), '.agentiq');

// a boolean or one of the levels. anything else is ignored rather than passed
// through, since ollama rejects a value it does not recognise and that would
// cost the session rather than the setting
export const toThink = (value?: string): ThinkSetting | undefined => {
  if (!value) {
    return;
  }

  const spelled = value.trim().toLowerCase();

  if (truthy.includes(spelled)) {
    return true;
  }

  if (falsy.includes(spelled)) {
    return false;
  }

  const levels = Object.values(ThinkLevel);
  const found = levels.find((level) => level === spelled);

  if (found) {
    return found;
  }

  console.warn(
    `Ignoring AQ_OLLAMA_THINK "${value}" - expected true, false, or one of ${levels.join(', ')}`
  );
};

// the same spellings toThink accepts, for a setting that is only ever on or
// off. an unrecognised value falls back rather than counting as false, since
// a typo meaning the opposite of what was written is worse than being ignored
export const toBoolean = (
  value: string | undefined,
  name: string,
  fallback = false
) => {
  if (!value) {
    return fallback;
  }

  const spelled = value.trim().toLowerCase();

  if (truthy.includes(spelled)) {
    return true;
  }

  if (falsy.includes(spelled)) {
    return false;
  }

  console.warn(
    `Ignoring ${name} "${value}" - expected one of ${[...truthy, ...falsy].join(', ')}`
  );

  return fallback;
};

export const logging: LoggingConfig = {
  level: toLogLevel(process.env.AQ_LOG_LEVEL),
  detailed: toBoolean(process.env.AQ_LOG_DETAILED, 'AQ_LOG_DETAILED')
};

// only the starting mode - shift+tab and present_plan move it at runtime, so
// modules/approval.ts owns the live value from here on
export const approval: ApprovalConfig = {
  mode: (process.env.AQ_APPROVAL_MODE || ApprovalMode.Manual) as ApprovalMode
};

// undefined lets execSync pick the platform default - cmd.exe on Windows,
// /bin/sh elsewhere - rather than assuming bash is on PATH
export const shell: ShellConfig = {
  path: process.env.AQ_SHELL || undefined,
  timeout: parseInt(process.env.AQ_SHELL_TIMEOUT ?? '120000', 10)
};

export const ollama: OllamaConfig = {
  bearerToken: process.env.AQ_OLLAMA_BEARER_TOKEN,
  host: process.env.AQ_OLLAMA_HOST,
  model: process.env.AQ_OLLAMA_MODEL ?? '',
  contextLimit: parseInt(process.env.AQ_OLLAMA_CONTEXT_LIMIT ?? '131072', 10),
  // ollama's own default is five minutes, which is short enough that a pause
  // to read something costs a full reload of the model on the next turn
  keepAlive: process.env.AQ_OLLAMA_KEEP_ALIVE ?? '30m',
  minTurnDelay: parseInt(process.env.AQ_OLLAMA_MIN_TURN_DELAY ?? '0', 10),
  think: toThink(process.env.AQ_OLLAMA_THINK),
  replayPreamble: toBoolean(
    process.env.AQ_OLLAMA_REPLAY_PREAMBLE,
    'AQ_OLLAMA_REPLAY_PREAMBLE'
  )
};

export const session: SessionConfig = {
  limit: parseInt(process.env.AQ_SESSION_LIMIT ?? '50', 10),
  historyLimit: parseInt(process.env.AQ_HISTORY_LIMIT ?? '100', 10)
};

export const tokenizer: TokenizerConfig = {
  repo: process.env.AQ_HF_TOKENIZER_REPO,
  // HF_TOKEN is the name the huggingface CLI already writes, so honour it
  hfToken: process.env.AQ_HF_TOKEN || process.env.HF_TOKEN
};
