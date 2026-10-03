import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

import { isCollection, parse, parseDocument } from 'yaml';

import { defaultConfig } from './config.default';

import {
  type ApprovalConfig,
  ApprovalMode,
  ThinkLevel,
  type ThinkSetting,
  type LoggingConfig,
  LogLevel,
  type OllamaConfig,
  type ExploreConfig,
  type RoadmapConfig,
  type SessionConfig,
  type SkillsConfig,
  type ShellConfig,
  type TokenizerConfig,
  type AnthropicConfig,
  type ProviderConfig,
  Provider
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
      `Ignoring logging.level (AQ_LOG_LEVEL) "${value}" - expected one of ${levels.join(', ')}`
    );

    return LogLevel.Info;
  }

  return found;
};

// everything agentiq keeps between runs - config.yml, sessions, tokenizer
// caches - lives under here. it is overridable so a test run cannot reach the real one, and
// so a user can move the whole lot off their home directory
export const home = process.env.AQ_HOME || resolve(homedir(), '.agentiq');

// a boolean or one of the levels. anything else is ignored rather than passed
// through, since a server rejects a value it does not recognise and that would
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
    `Ignoring provider.think (AQ_THINK) "${value}" - expected true, false, or one of ${levels.join(', ')}`
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

// config.yml as written: sections of settings, any of which may be missing,
// and a section holding nothing but comments parses as null
type ConfigFile = Record<string, Record<string, unknown> | null | undefined>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// seeds the file with the commented defaults the first time, so there is
// something to edit, and never touches it after that. a file that cannot be
// read or parsed is reported and ignored rather than fatal - the defaults and
// the environment are still a working configuration
export const loadConfigFile = (dir: string): ConfigFile => {
  const path = resolve(dir, 'config.yml');

  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, defaultConfig, { flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      console.warn(`Could not create ${path} - ${(error as Error).message}`);

      return {};
    }
  }

  try {
    const parsed: unknown = parse(readFileSync(path, 'utf8'));

    // an emptied file is as good as no settings at all
    if (parsed === null || parsed === undefined) {
      return {};
    }

    if (!isRecord(parsed)) {
      console.warn(`Ignoring ${path} - expected a mapping of settings`);

      return {};
    }

    return parsed as ConfigFile;
  } catch (error) {
    console.warn(`Ignoring ${path} - ${(error as Error).message}`);

    return {};
  }
};

// writes one setting back into config.yml for the runs that follow. the file
// is edited in place rather than written out again, so the comments and
// anything else the user put there survive. throws if the file cannot be read
// or parsed - overwriting one that is broken would lose whatever was in it
export const saveSetting = (
  section: string,
  key: string,
  value: unknown,
  dir = home
) => {
  const path = resolve(dir, 'config.yml');
  const document = parseDocument(readFileSync(path, 'utf8'));

  if (document.errors.length) {
    throw document.errors[0];
  }

  // a section holding nothing but comments parses as null, which setIn
  // cannot reach into
  if (document.has(section) && !isCollection(document.get(section, true))) {
    document.set(section, document.createNode({ [key]: value }));
  } else {
    document.setIn([section, key], value);
  }

  writeFileSync(path, document.toString());

  return path;
};

const defaults = parse(defaultConfig) as ConfigFile;
const file = loadConfigFile(home);

const lookup = (source: ConfigFile, section: string, key: string) => {
  const values = source[section];

  return isRecord(values) ? values[key] : undefined;
};

// the env var wins, then config.yml, then the seeded default. everything comes
// back as a string so the parsers above read a value the same way wherever it
// came from - an empty env var counts as unset, as it always has
const setting = (envName: string, section: string, key: string) => {
  const fromEnv = process.env[envName];

  if (fromEnv) {
    return fromEnv;
  }

  const value = lookup(file, section, key) ?? lookup(defaults, section, key);

  return value === null || value === undefined ? undefined : String(value);
};

const integer = (envName: string, section: string, key: string) =>
  parseInt(setting(envName, section, key) ?? '', 10);

// a provider setting that used to be an ollama one. the new name wins over the
// old at each level, but the seeded default comes last of all - otherwise an
// ollama.contextLimit already in someone's config.yml would lose to the
// default seeded under provider, and their setting would silently stop working
const renamed = (envName: string, legacyEnvName: string, key: string) => {
  const fromEnv = process.env[envName] || process.env[legacyEnvName];

  if (fromEnv) {
    return fromEnv;
  }

  const value =
    lookup(file, 'provider', key) ??
    lookup(file, 'ollama', key) ??
    lookup(defaults, 'provider', key);

  return value === null || value === undefined ? undefined : String(value);
};

export const logging: LoggingConfig = {
  level: toLogLevel(setting('AQ_LOG_LEVEL', 'logging', 'level')),
  detailed: toBoolean(
    setting('AQ_LOG_DETAILED', 'logging', 'detailed'),
    'logging.detailed (AQ_LOG_DETAILED)'
  ),
  logThoughts: toBoolean(
    setting('AQ_LOG_THOUGHTS', 'logging', 'logThoughts'),
    'logging.logThoughts (AQ_LOG_THOUGHTS)'
  )
};

// only the starting mode - shift+tab and present_plan move it at runtime, so
// modules/approval.ts owns the live value from here on
export const approval: ApprovalConfig = {
  mode: (setting('AQ_APPROVAL_MODE', 'approval', 'mode') ||
    ApprovalMode.Manual) as ApprovalMode
};

// undefined lets execSync pick the platform default - cmd.exe on Windows,
// /bin/sh elsewhere - rather than assuming bash is on PATH
export const shell: ShellConfig = {
  path: setting('AQ_SHELL', 'shell', 'path') || undefined,
  timeout: integer('AQ_SHELL_TIMEOUT', 'shell', 'timeout')
};

export const provider: ProviderConfig = {
  name: setting('AQ_PROVIDER', 'provider', 'name') as Provider,
  // filled in by modules/models.ts from ~/.agentiq/models.yml. there is no
  // setting for it: /model has to be able to change it mid-session, and a value
  // read from config.yml could not be changed back by the same command
  model: '',
  contextLimit: parseInt(
    renamed('AQ_CONTEXT_LIMIT', 'AQ_OLLAMA_CONTEXT_LIMIT', 'contextLimit') ??
      '',
    10
  ),
  minTurnDelay: parseInt(
    renamed('AQ_MIN_TURN_DELAY', 'AQ_OLLAMA_MIN_TURN_DELAY', 'minTurnDelay') ??
      '',
    10
  ),
  think: toThink(renamed('AQ_THINK', 'AQ_OLLAMA_THINK', 'think'))
};

export const anthropic: AnthropicConfig = {
  apiKey: setting('AQ_ANTHROPIC_API_KEY', 'anthropic', 'apiKey') || ''
};

export const ollama: OllamaConfig = {
  bearerToken: setting('AQ_OLLAMA_BEARER_TOKEN', 'ollama', 'bearerToken'),
  host: setting('AQ_OLLAMA_HOST', 'ollama', 'host'),
  // ollama's own default is five minutes, which is short enough that a pause
  // to read something costs a full reload of the model on the next turn
  keepAlive: setting('AQ_OLLAMA_KEEP_ALIVE', 'ollama', 'keepAlive') ?? '30m',
  replayPreamble: toBoolean(
    setting('AQ_OLLAMA_REPLAY_PREAMBLE', 'ollama', 'replayPreamble'),
    'ollama.replayPreamble (AQ_OLLAMA_REPLAY_PREAMBLE)'
  ),
  recoverToolCalls: toBoolean(
    setting('AQ_OLLAMA_RECOVER_TOOL_CALLS', 'ollama', 'recoverToolCalls'),
    'ollama.recoverToolCalls (AQ_OLLAMA_RECOVER_TOOL_CALLS)',
    true
  )
};

export const session: SessionConfig = {
  limit: integer('AQ_SESSION_LIMIT', 'session', 'limit'),
  historyLimit: integer('AQ_HISTORY_LIMIT', 'session', 'historyLimit'),
  recapTurns: integer('AQ_RECAP_TURNS', 'session', 'recapTurns')
};

export const tokenizer: TokenizerConfig = {
  // set alongside provider.model, from the same entry - the pair is chosen and
  // stored together
  repo: undefined,
  // HF_TOKEN is the name the huggingface CLI already writes, so honour it
  hfToken:
    setting('AQ_HF_TOKEN', 'tokenizer', 'hfToken') || process.env.HF_TOKEN
};

// off by default: ROADMAP.md is written into the project without an approval
// prompt, so it should only happen in a project that has asked for it
export const roadmap: RoadmapConfig = {
  enabled: toBoolean(
    setting('AQ_ENABLE_ROADMAP', 'roadmap', 'enabled'),
    'roadmap.enabled (AQ_ENABLE_ROADMAP)'
  )
};

// on by default: an exploration only ever reads, so there is nothing to approve,
// and it keeps the files it reads out of the main conversation
export const explore: ExploreConfig = {
  enabled: toBoolean(
    setting('AQ_EXPLORE', 'explore', 'enabled'),
    'explore.enabled (AQ_EXPLORE)',
    true
  ),
  rounds: integer('AQ_EXPLORE_ROUNDS', 'explore', 'rounds')
};

// a list, so it is read from the file as it is rather than through setting(),
// which makes a string of everything. there is no env var for it either: one
// would override what /skills saves without /skills being able to tell
export const toSkillNames = (value: unknown, name: string) => {
  if (value === null || value === undefined) {
    return [];
  }

  if (!Array.isArray(value)) {
    console.warn(`Ignoring ${name} - expected a list of skill names`);

    return [];
  }

  const names = value.filter(
    (entry): entry is string => typeof entry === 'string'
  );

  if (names.length < value.length) {
    console.warn(`Ignoring the entries of ${name} that are not skill names`);
  }

  return names;
};

export const skills: SkillsConfig = {
  disabled: toSkillNames(lookup(file, 'skills', 'disabled'), 'skills.disabled')
};
