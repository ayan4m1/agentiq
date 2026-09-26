import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';

// like commands/run.ts, the command runs as it is evaluated, so it can only be
// run, not imported. the loop it drives is covered by modules/repl.ts - this is
// only whether it gets that far, how it stops when it cannot, and what it exits
// with once it has
const register = new URL('../../test/register.mjs', import.meta.url).href;
const entrypoint = fileURLToPath(new URL('./exec.ts', import.meta.url));
const root = mkdtempSync(resolve(tmpdir(), 'agentiq-exec-'));
const model = 'gemma4:e4b';
// nothing listens on port 1, so the connection is refused straight away
const unreachable = 'http://127.0.0.1:1';

let host = unreachable;

// spawned rather than spawnSync, since the stand-in server below lives in this
// process and could not answer while it was blocked waiting on the command
const run = (home: string, ...args: string[]) =>
  new Promise<{ status: number | null; stdout: string; stderr: string }>(
    (done, fail) => {
      const child = spawn(
        process.execPath,
        ['--import', register, entrypoint, ...args],
        {
          // away from the repository, so a .env there cannot change the outcome
          cwd: root,
          env: {
            ...process.env,
            AQ_HOME: resolve(root, home),
            AQ_OLLAMA_HOST: host
          },
          // stdin is not a terminal, and nothing may wait on it
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 30000
        }
      );
      let stdout = '';
      let stderr = '';

      child.stdout.setEncoding('utf-8').on('data', (chunk) => {
        stdout += chunk;
      });
      child.stderr.setEncoding('utf-8').on('data', (chunk) => {
        stderr += chunk;
      });
      child.on('error', fail);
      child.on('close', (status) => done({ status, stdout, stderr }));
    }
  );

// a home with a model already chosen, so startup gets as far as the server. the
// tokenizer is already "cached", so nothing is fetched from huggingface.co -
// that it cannot be parsed only means token counts are estimated instead
const configured = (name = 'configured') => {
  const home = resolve(root, name);
  const cache = resolve(home, 'tokenizers', 'google', 'gemma-4-E4B');

  mkdirSync(cache, { recursive: true });
  writeFileSync(
    resolve(home, 'models.json'),
    JSON.stringify({
      active: model,
      models: [{ model, tokenizer: 'google/gemma-4-E4B' }]
    })
  );
  writeFileSync(resolve(cache, 'tokenizer.json'), '{}');
  writeFileSync(resolve(cache, 'tokenizer_config.json'), '{}');

  return name;
};

describe('exec', () => {
  test('describes its arguments and options', async () => {
    const { status, stdout } = await run('empty', '--help');

    assert.equal(status, 0);
    assert.match(stdout, /<prompt>/);
    assert.match(stdout, /-m, --mode <mode>/);
    assert.match(stdout, /"manual", "auto",\s+"plan"/);
  });

  test('needs a prompt', async () => {
    const { status, stderr } = await run('empty');

    assert.notEqual(status, 0);
    assert.match(stderr, /missing required argument 'prompt'/);
  });

  test('refuses an approval mode it does not know', async () => {
    const { status, stderr } = await run('empty', 'hello', '--mode', 'yolo');

    assert.notEqual(status, 0);
    assert.match(stderr, /Allowed choices are manual, auto, plan/);
  });

  test('stops rather than asking when no model has been set up', async () => {
    const { status, stdout, stderr } = await run(
      'empty',
      'hello',
      '-m',
      'auto'
    );

    assert.equal(status, 1);
    assert.match(stdout + stderr, /No model has been set up/);
  });

  test('stops when ollama cannot be reached', async () => {
    const { status, stdout, stderr } = await run(
      configured(),
      'hello',
      '-m',
      'plan'
    );

    assert.equal(status, 1);
    assert.match(
      stdout + stderr,
      /Could not reach ollama at http:\/\/127\.0\.0\.1:1/
    );
  });

  describe('with ollama answering', () => {
    let server: Server;
    // what the next chat request is answered with, and what each one asked
    let reply: { status: number; lines: object[] };
    let asked: { messages: { role: string; content: string }[] }[];

    before(async () => {
      server = createServer((request, response) => {
        let body = '';

        request.on('data', (chunk) => {
          body += chunk;
        });
        request.on('end', () => {
          response.setHeader('Content-Type', 'application/json');

          if (request.url === '/api/tags') {
            response.end(JSON.stringify({ models: [{ name: model, model }] }));
          } else if (request.url === '/api/show') {
            response.end(
              JSON.stringify({ capabilities: ['completion', 'tools'] })
            );
          } else if (request.url === '/api/chat') {
            asked.push(JSON.parse(body));
            response.statusCode = reply.status;
            response.end(
              reply.lines.map((line) => `${JSON.stringify(line)}\n`).join('')
            );
          } else {
            response.statusCode = 404;
            response.end(JSON.stringify({ error: 'not found' }));
          }
        });
      });

      await new Promise<void>((listening) =>
        server.listen(0, '127.0.0.1', listening)
      );
      host = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    after(() => {
      host = unreachable;
      server.close();
    });

    test('answers the prompt and exits cleanly', async () => {
      asked = [];
      reply = {
        status: 200,
        lines: [
          {
            model,
            message: { role: 'assistant', content: 'Hi from the model' },
            done: false
          },
          {
            model,
            message: { role: 'assistant', content: '' },
            done: true,
            done_reason: 'stop',
            prompt_eval_count: 10,
            eval_count: 5
          }
        ]
      };

      const home = configured('answered');
      const { status, stdout, stderr } = await run(
        home,
        'say hi',
        '-m',
        'auto'
      );

      assert.equal(status, 0, stdout + stderr);
      assert.match(stdout, /Hi from the model/);
      assert.equal(asked.length, 1);
      assert.deepEqual(asked[0].messages.at(-1), {
        role: 'user',
        content: 'say hi'
      });

      // the session it names is the one it wrote, ready to be resumed
      const [id] = stdout.match(/(?<=--resume )[\w-]+/) ?? [];

      assert.ok(id, stdout);
      assert.ok(existsSync(resolve(root, home, 'sessions', `${id}.jsonl`)));
    });

    test('exits with an error when the model call fails', async () => {
      asked = [];
      reply = { status: 500, lines: [{ error: 'model exploded' }] };

      const { status, stdout, stderr } = await run(
        configured('failed'),
        'say hi',
        '-m',
        'auto'
      );

      assert.equal(status, 1);
      assert.equal(asked.length, 1);
      assert.match(stdout + stderr, /The model call failed: .*model exploded/);
      assert.match(stdout + stderr, /resume with agentiq run --resume/);
    });
  });
});
