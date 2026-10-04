import { test, describe, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';

import type { McpConnection, McpResult, McpTool } from './mcp';
import type { McpServerConfig } from '../types';

const {
  closeServers,
  connectServers,
  describeResult,
  isMcpTool,
  listServers,
  toolName,
  toToolCall
} = await import('./mcp');
const { approval, remember } = await import('./approval');
const { terminal } = await import('./turn');
const { ApprovalMode } = await import('../types');

const tool = (name: string, readOnly = false): McpTool => ({
  name,
  description: `does ${name}`,
  inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
  ...(readOnly ? { annotations: { readOnlyHint: true } } : {})
});

// a server that lists these tools and answers every call with this result
const fakeConnection = (
  tools: McpTool[] = [],
  result: McpResult = { content: [{ type: 'text', text: 'done' }] }
) => ({
  listTools: mock.fn(async () => ({ tools })),
  callTool: mock.fn(async (): Promise<McpResult> => result),
  close: mock.fn(async () => {}),
  kill: mock.fn()
});

const stdio: McpServerConfig = { command: 'fake-server' };

const original = process.cwd();
let root: string;

beforeEach(() => {
  // approval rules are kept per project directory, so each test gets its own
  root = mkdtempSync(resolve(tmpdir(), 'agentiq-mcp-'));
  process.chdir(root);
  approval.mode = ApprovalMode.Auto;
  terminal.interactive = true;
});

afterEach(() => {
  process.chdir(original);
  rmSync(root, { recursive: true, force: true });
  closeServers();
});

describe('toolName', () => {
  test('prefixes the server so tools cannot collide', () => {
    assert.equal(toolName('github', 'search'), 'mcp__github__search');
    assert.ok(isMcpTool(toolName('github', 'search')));
    assert.equal(isMcpTool('read'), false);
  });

  test('replaces characters a provider would refuse', () => {
    assert.equal(
      toolName('my server', 'get.item/v2'),
      'mcp__my_server__get_item_v2'
    );
  });

  test('stops at 64 characters', () => {
    assert.equal(toolName('server', 'x'.repeat(100)).length, 64);
  });
});

describe('describeResult', () => {
  test('joins the text parts', () => {
    assert.equal(
      describeResult({
        content: [
          { type: 'text', text: 'one' },
          { type: 'resource', resource: { text: 'two' } }
        ]
      }),
      'one\ntwo'
    );
  });

  test('names the parts it cannot show', () => {
    assert.equal(
      describeResult({ content: [{ type: 'image' }] }),
      '[image content omitted]'
    );
  });

  test('falls back to structured content', () => {
    assert.equal(
      describeResult({ content: [], structuredContent: { n: 1 } }),
      '{"n":1}'
    );
  });

  test('says when there was nothing', () => {
    assert.equal(describeResult({}), 'The tool returned no output.');
  });

  test('marks an error as one', () => {
    assert.equal(
      describeResult({
        content: [{ type: 'text', text: 'bad' }],
        isError: true
      }),
      'The tool reported an error: bad'
    );
  });
});

describe('connectServers', () => {
  test('offers every tool of every server', async () => {
    const connections: Record<string, McpConnection> = {
      one: fakeConnection([tool('a'), tool('b')]),
      two: fakeConnection([tool('c')])
    };

    const tools = await connectServers(
      { one: stdio, two: { url: 'http://example/mcp' } },
      async (name) => connections[name],
      1000
    );

    assert.deepEqual(
      tools.map((entry) => entry.definition.function.name),
      ['mcp__one__a', 'mcp__one__b', 'mcp__two__c']
    );
    assert.deepEqual(listServers(), [
      { name: 'one', transport: 'stdio', tools: 2 },
      { name: 'two', transport: 'http', tools: 1 }
    ]);
  });

  test('passes the input schema on as the parameters', async () => {
    const [entry] = await connectServers(
      { one: stdio },
      async () => fakeConnection([tool('a')]),
      1000
    );

    assert.deepEqual(
      entry.definition.function.parameters,
      tool('a').inputSchema
    );
    assert.equal(entry.definition.function.description, 'does a');
  });

  test('reads every page of a long listing', async () => {
    const connection = fakeConnection();

    connection.listTools.mock.mockImplementation(
      async (params?: { cursor?: string }) =>
        params?.cursor
          ? { tools: [tool('b')] }
          : { tools: [tool('a')], nextCursor: 'next' }
    );

    const tools = await connectServers(
      { one: stdio },
      async () => connection,
      1000
    );

    assert.equal(tools.length, 2);
  });

  test('leaves out a server that fails and keeps the rest', async () => {
    const tools = await connectServers(
      { broken: stdio, fine: stdio },
      async (name) => {
        if (name === 'broken') {
          throw new Error('spawn fake-server ENOENT');
        }

        return fakeConnection([tool('a')]);
      },
      1000
    );

    assert.deepEqual(
      tools.map((entry) => entry.definition.function.name),
      ['mcp__fine__a']
    );
    assert.equal(listServers()[0].error, 'spawn fake-server ENOENT');
  });

  test('stops a server that takes too long to list its tools', async () => {
    const connection = fakeConnection();

    connection.listTools.mock.mockImplementation(() => new Promise(() => {}));

    const tools = await connectServers(
      { slow: stdio },
      async () => connection,
      10
    );

    assert.deepEqual(tools, []);
    assert.match(listServers()[0].error ?? '', /took longer than 10ms/);
    assert.equal(connection.kill.mock.callCount(), 1);
  });

  test('stops a server that connects only after the timeout', async () => {
    const connection = fakeConnection([tool('a')]);

    const tools = await connectServers(
      { late: stdio },
      () => new Promise((resolve) => setTimeout(() => resolve(connection), 30)),
      10
    );

    assert.deepEqual(tools, []);
    assert.match(listServers()[0].error ?? '', /took longer than 10ms/);

    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.equal(connection.kill.mock.callCount(), 1);
    assert.equal(connection.close.mock.callCount(), 1);
  });

  test('stops every server it connected to on the way out', async () => {
    const connection = fakeConnection([tool('a')]);

    await connectServers({ one: stdio }, async () => connection, 1000);
    closeServers();

    assert.equal(connection.kill.mock.callCount(), 1);
    assert.equal(connection.close.mock.callCount(), 1);
  });
});

describe('an MCP tool', () => {
  const call = (
    connection: ReturnType<typeof fakeConnection>,
    args: Record<string, unknown>,
    readOnly = false
  ) =>
    (
      toToolCall('srv', tool('lookup', readOnly), connection).handler as (
        args: Record<string, unknown>
      ) => Promise<string>
    )(args);

  test('hands its arguments to the server as they are', async () => {
    const connection = fakeConnection();
    const args = { query: 'x', nested: { deep: [1, 2] } };

    assert.equal(await call(connection, args), 'done');
    assert.deepEqual(connection.callTool.mock.calls[0].arguments, [
      { name: 'lookup', arguments: args }
    ]);
  });

  test('is refused in plan mode', async () => {
    const connection = fakeConnection();

    approval.mode = ApprovalMode.Plan;

    assert.match(await call(connection, {}), /Plan mode is active/);
    assert.equal(connection.callTool.mock.callCount(), 0);
  });

  test('may run in plan mode when the server says it only reads', async () => {
    const connection = fakeConnection();

    approval.mode = ApprovalMode.Plan;
    terminal.interactive = false;
    remember('tool', 'mcp__srv__lookup');

    assert.equal(await call(connection, {}, true), 'done');
  });

  test('runs without asking once a rule allows it', async () => {
    const connection = fakeConnection();

    approval.mode = ApprovalMode.Manual;
    terminal.interactive = false;
    remember('tool', 'mcp__srv__*');

    assert.equal(await call(connection, {}), 'done');
  });

  test('is declined when nobody is there to approve it', async () => {
    const connection = fakeConnection();

    approval.mode = ApprovalMode.Manual;
    terminal.interactive = false;

    assert.match(
      await call(connection, {}),
      /declined to call mcp__srv__lookup/
    );
    assert.equal(connection.callTool.mock.callCount(), 0);
  });

  test('cuts a long result short', async () => {
    const connection = fakeConnection([], {
      content: [{ type: 'text', text: 'x'.repeat(5_000_000) }]
    });

    const result = await call(connection, {});

    assert.ok(result.length < 5_000_000);
    assert.match(result, /\[truncated: showing \d+ of 5000000 characters\]/);
  });
});
