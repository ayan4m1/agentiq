import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';

import { parse } from 'yaml';

import {
  loadConfigFile,
  saveSetting,
  toBoolean,
  toLogLevel,
  toThink
} from './config';
import { defaultConfig } from './config.default';
import { LogLevel } from '../types';

// both parsers warn on the console when they reject something, which these
// tests do on purpose
const quietly = <T>(work: () => T) => {
  const spoke = console.warn;

  console.warn = () => {};

  try {
    return work();
  } finally {
    console.warn = spoke;
  }
};

describe('toLogLevel', () => {
  for (const level of Object.values(LogLevel)) {
    test(`accepts ${level}`, () => {
      assert.equal(toLogLevel(level), level);
    });
  }

  test('defaults to info when nothing is set', () => {
    assert.equal(toLogLevel(undefined), LogLevel.Info);
    assert.equal(toLogLevel(''), LogLevel.Info);
  });

  test('falls back rather than going silent on a bad level', () => {
    // winston does not reject an unknown level, it just fails every comparison
    // and logs nothing at all
    assert.equal(
      quietly(() => toLogLevel('verbose')),
      LogLevel.Info
    );
  });

  test('does not accept warning spelled out, which winston calls warn', () => {
    assert.equal(
      quietly(() => toLogLevel('warning')),
      LogLevel.Info
    );
  });
});

describe('toThink', () => {
  test('is undefined when unset, so the field is not sent at all', () => {
    assert.equal(toThink(undefined), undefined);
    assert.equal(toThink(''), undefined);
  });

  for (const spelling of ['true', 'yes', '1', 'TRUE', ' True ']) {
    test(`reads ${JSON.stringify(spelling)} as on`, () => {
      assert.equal(toThink(spelling), true);
    });
  }

  for (const spelling of ['false', 'no', '0', 'False']) {
    test(`reads ${JSON.stringify(spelling)} as off`, () => {
      // an explicit false has to survive, or it could not turn off a default
      assert.equal(toThink(spelling), false);
    });
  }

  for (const level of ['high', 'medium', 'low']) {
    test(`passes ${level} through as a level`, () => {
      assert.equal(toThink(level), level);
    });
  }

  test('accepts a level whatever its case', () => {
    assert.equal(toThink('HIGH'), 'high');
  });

  test('ignores a value ollama would reject', () => {
    // sending one costs every turn of the session, not just the setting
    assert.equal(
      quietly(() => toThink('maximum')),
      undefined
    );
  });
});

describe('toBoolean', () => {
  for (const spelling of ['true', 'yes', '1', 'TRUE', ' yes ']) {
    test(`reads ${JSON.stringify(spelling)} as on`, () => {
      assert.equal(toBoolean(spelling, 'AQ_TEST'), true);
    });
  }

  for (const spelling of ['false', 'no', '0', 'No']) {
    test(`reads ${JSON.stringify(spelling)} as off`, () => {
      assert.equal(toBoolean(spelling, 'AQ_TEST', true), false);
    });
  }

  test('uses the fallback when nothing is set', () => {
    assert.equal(toBoolean(undefined, 'AQ_TEST'), false);
    assert.equal(toBoolean('', 'AQ_TEST', true), true);
  });

  test('keeps the fallback rather than reading a typo as off', () => {
    // a value meaning the opposite of what was written is worse than one that
    // was ignored and said so
    assert.equal(
      quietly(() => toBoolean('ture', 'AQ_TEST', true)),
      true
    );
  });
});

const root = mkdtempSync(resolve(tmpdir(), 'agentiq-config-'));

describe('loadConfigFile', () => {
  test('seeds config.yml with the defaults when there is none', () => {
    const dir = resolve(root, 'fresh', 'home');
    const loaded = loadConfigFile(dir);

    assert.equal(
      readFileSync(resolve(dir, 'config.yml'), 'utf8'),
      defaultConfig
    );
    assert.deepEqual(loaded, parse(defaultConfig));
  });

  test('the seeded defaults match the shape config.ts reads', () => {
    const seeded = parse(defaultConfig);

    assert.equal(seeded.logging.level, LogLevel.Info);
    assert.equal(seeded.approval.mode, 'manual');
    assert.equal(seeded.shell.timeout, 120000);
    assert.equal(seeded.ollama.contextLimit, 131072);
    assert.equal(seeded.ollama.recoverToolCalls, true);
    assert.equal(seeded.session.limit, 50);
    assert.equal(seeded.roadmap.enabled, false);
  });

  test('never overwrites a file that is already there', () => {
    const dir = resolve(root, 'existing');
    const written = 'session:\n  limit: 7\n';

    mkdirSync(dir);
    writeFileSync(resolve(dir, 'config.yml'), written);

    assert.deepEqual(loadConfigFile(dir), { session: { limit: 7 } });
    assert.equal(readFileSync(resolve(dir, 'config.yml'), 'utf8'), written);
  });

  test('treats an emptied file as no settings', () => {
    const dir = resolve(root, 'empty');

    mkdirSync(dir);
    writeFileSync(resolve(dir, 'config.yml'), '');

    assert.deepEqual(loadConfigFile(dir), {});
  });

  test('ignores a file that is not valid yaml rather than failing', () => {
    const dir = resolve(root, 'broken');

    mkdirSync(dir);
    writeFileSync(resolve(dir, 'config.yml'), 'session: [unclosed\n');

    assert.deepEqual(
      quietly(() => loadConfigFile(dir)),
      {}
    );
  });

  test('ignores a file that is not a mapping', () => {
    const dir = resolve(root, 'list');

    mkdirSync(dir);
    writeFileSync(resolve(dir, 'config.yml'), '- one\n- two\n');

    assert.deepEqual(
      quietly(() => loadConfigFile(dir)),
      {}
    );
  });
});

describe('saveSetting', () => {
  const seed = (tag: string, yaml: string) => {
    const dir = resolve(root, `save-${tag}`);

    mkdirSync(dir);
    writeFileSync(resolve(dir, 'config.yml'), yaml);

    return dir;
  };
  const read = (dir: string) =>
    readFileSync(resolve(dir, 'config.yml'), 'utf8');

  test('changes the one value and keeps the comments', () => {
    const dir = seed('defaults', defaultConfig);

    saveSetting('ollama', 'contextLimit', 32768, dir);

    assert.equal(
      read(dir),
      defaultConfig.replace('contextLimit: 131072', 'contextLimit: 32768')
    );
  });

  test('adds a setting the file leaves out', () => {
    const dir = seed('missing', 'session:\n  limit: 7\n');

    saveSetting('ollama', 'contextLimit', 32768, dir);

    assert.deepEqual(parse(read(dir)), {
      session: { limit: 7 },
      ollama: { contextLimit: 32768 }
    });
  });

  test('fills a section that holds nothing but comments', () => {
    const dir = seed('comments', 'ollama:\n  # nothing yet\n');

    saveSetting('ollama', 'contextLimit', 32768, dir);

    assert.deepEqual(parse(read(dir)), { ollama: { contextLimit: 32768 } });
  });

  test('refuses to overwrite a file that is not valid yaml', () => {
    const written = 'session: [unclosed\n';
    const dir = seed('broken', written);

    assert.throws(() => saveSetting('ollama', 'contextLimit', 32768, dir));
    assert.equal(read(dir), written);
  });
});

describe('settings', () => {
  // the module reads everything as it is evaluated, and only once per URL - a
  // query string makes each import a fresh evaluation against the env as set
  const load = async (
    tag: string,
    yaml: string,
    env: Record<string, string> = {}
  ) => {
    const home = resolve(root, `settings-${tag}`);
    const saved = { ...process.env };

    mkdirSync(home);
    writeFileSync(resolve(home, 'config.yml'), yaml);
    Object.assign(process.env, { AQ_HOME: home }, env);

    try {
      return await import(new URL(`./config.ts?${tag}`, import.meta.url).href);
    } finally {
      process.env = saved;
    }
  };

  test('reads values from config.yml', async () => {
    const config = await load(
      'file',
      'session:\n  limit: 7\nollama:\n  think: high\nroadmap:\n  enabled: true\n'
    );

    assert.equal(config.session.limit, 7);
    assert.equal(config.ollama.think, 'high');
    assert.equal(config.roadmap.enabled, true);
  });

  test('falls back to the defaults for anything the file leaves out', async () => {
    const config = await load('partial', 'session:\n  limit: 7\n');

    assert.equal(config.session.historyLimit, 100);
    assert.equal(config.shell.timeout, 120000);
    assert.equal(config.ollama.keepAlive, '30m');
    assert.equal(config.ollama.recoverToolCalls, true);
    assert.equal(config.ollama.think, undefined);
  });

  test('lets an AQ_* env var override the file', async () => {
    const config = await load(
      'env',
      'session:\n  limit: 7\nroadmap:\n  enabled: true\n',
      { AQ_SESSION_LIMIT: '3', AQ_ENABLE_ROADMAP: 'false' }
    );

    assert.equal(config.session.limit, 3);
    assert.equal(config.roadmap.enabled, false);
  });

  test('reads config.yml from AQ_HOME', async () => {
    const config = await load('home', 'logging:\n  level: debug\n');

    assert.equal(config.home, resolve(root, 'settings-home'));
    assert.equal(config.logging.level, LogLevel.Debug);
  });
});
