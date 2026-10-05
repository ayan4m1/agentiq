import chalk from 'chalk';
import ora from 'ora';
import { execFileSync } from 'node:child_process';
// the sdk publishes these through a "./*" wildcard export, which node and tsc
// follow but the lint resolver does not
/* eslint-disable import-x/no-unresolved */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
/* eslint-enable import-x/no-unresolved */

import { mcp as config, saveSetting } from './config';
import { getLogger } from './logging';
import { showElapsed } from './elapsed';
import { describeDenial, refusePlanning, requestApproval } from './approval';
import type { McpServerConfig, ToolCall, ToolDefinition } from '../types';
import { commandOutputBudget, describeError, truncate } from '../utils';

const log = getLogger('mcp');

// the part of a tool listing agentiq reads - the rest of what a server sends
// back is passed over
export type McpTool = {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean };
};

// the part of a tool result agentiq reads. content is a list of parts, only
// some of which are text a model can be shown
export type McpResult = {
  content?: { type: string; text?: string; resource?: { text?: string } }[];
  structuredContent?: unknown;
  isError?: boolean;
};

// one live server, narrowed to what is used so a test can stand in for it
export type McpConnection = {
  listTools: (params?: {
    cursor?: string;
  }) => Promise<{ tools: McpTool[]; nextCursor?: string }>;
  callTool: (params: {
    name: string;
    arguments: Record<string, unknown>;
  }) => Promise<McpResult>;
  close: () => Promise<void>;
  // stops the server's process at once, for the exit handler, which cannot
  // wait for close() to finish
  kill?: () => void;
};

export type McpServerStatus = {
  name: string;
  transport: 'stdio' | 'http';
  tools: number;
  error?: string;
  // false for a server turned off in config.yml or from /mcp - it is listed,
  // but nothing is started for it
  enabled: boolean;
};

export type Connect = (
  name: string,
  server: McpServerConfig
) => Promise<McpConnection>;

const prefix = 'mcp__';

const connections = new Map<string, McpConnection>();
// each connected server's tools, so one can be taken away or replaced without
// touching the others
const serverTools = new Map<string, ToolCall[]>();
const statuses: McpServerStatus[] = [];
// what connectServers() was given, so a server connected again from /mcp is
// connected the same way
let configured: Record<string, McpServerConfig> = {};
let connector: Connect = (name, server) => connectClient(name, server);
let connectTimeout = config.timeout;

// what /mcp lists - every configured server, whether it came up or not
export const listServers = (): readonly McpServerStatus[] => statuses;

export const isMcpTool = (name: string) => name.startsWith(prefix);

// the server goes into the name so two servers with a "search" tool do not
// collide with each other or with a built-in. providers only accept these
// characters, and anthropic stops at 64 of them
export const toolName = (server: string, tool: string) =>
  `${prefix}${server}__${tool}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);

// on windows a server started through npx is a cmd.exe with node beneath it,
// and only taking down the whole tree stops the part doing the work
const killPid = (pid?: number) => {
  if (!pid) {
    return;
  }

  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/pid', String(pid), '/t', '/f'], {
        stdio: 'ignore'
      });
    } else {
      process.kill(pid, 'SIGTERM');
    }
  } catch {
    // it has already gone, which is what was wanted
  }
};

const connectClient: Connect = async (name, server) => {
  const client = new Client({ name: 'agentiq', version: '1.0.0' });

  if (server.url) {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(server.url), {
        requestInit: { headers: server.headers }
      })
    );

    return client as unknown as McpConnection;
  }

  const transport = new StdioClientTransport({
    command: server.command!,
    args: server.args,
    env: server.env,
    cwd: server.cwd,
    // inherited, a server's own logging would land in the middle of the
    // prompt - it is kept for debug logging instead
    stderr: 'pipe'
  });

  transport.stderr?.on('data', (chunk: Buffer) =>
    log.debug(`${name}: ${chunk.toString().trimEnd()}`)
  );

  await client.connect(transport);

  return Object.assign(client as unknown as McpConnection, {
    kill: () => killPid(transport.pid ?? undefined)
  });
};

// every page of the listing - a server with many tools splits them up
const listAll = async (connection: McpConnection) => {
  const tools: McpTool[] = [];
  let cursor: string | undefined;

  do {
    const page = await connection.listTools(cursor ? { cursor } : undefined);

    tools.push(...page.tools);
    cursor = page.nextCursor;
  } while (cursor);

  return tools;
};

const withTimeout = <T>(work: Promise<T>, ms: number, what: string) =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${what} took longer than ${ms}ms`)),
      ms
    );

    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });

// the text parts, joined. anything else - an image, a binary resource - is
// named rather than dropped, so the model knows there was more than it sees
export const describeResult = (result: McpResult) => {
  const parts = (result.content ?? []).map((part) => {
    if (part.type === 'text' && typeof part.text === 'string') {
      return part.text;
    }

    if (typeof part.resource?.text === 'string') {
      return part.resource.text;
    }

    return `[${part.type} content omitted]`;
  });

  // a server may answer with structured content alone
  if (!parts.length && result.structuredContent !== undefined) {
    parts.push(JSON.stringify(result.structuredContent));
  }

  const text = parts.join('\n') || 'The tool returned no output.';

  return result.isError ? `The tool reported an error: ${text}` : text;
};

// what the user is shown when asked - the arguments, cut short, since a whole
// document handed to a tool would push the question off the screen
const describeArgs = (args: Record<string, unknown>) => {
  const json = JSON.stringify(args);

  return json.length > 200 ? `${json.slice(0, 200)}…` : json;
};

export const toToolCall = (
  server: string,
  tool: McpTool,
  connection: McpConnection
): ToolCall => {
  const name = toolName(server, tool.name);
  const definition: ToolDefinition = {
    type: 'function',
    function: {
      name,
      description: tool.description ?? `The ${tool.name} tool from ${server}`,
      parameters: tool.inputSchema as ToolDefinition['function']['parameters']
    }
  };

  const handler = async (args: Record<string, unknown>) => {
    // readOnlyHint is the server's word for it, which is enough to let plan
    // mode look something up - but not enough to skip asking, since nothing
    // holds a server to what it says about itself
    if (!tool.annotations?.readOnlyHint) {
      const refusal = refusePlanning(`the ${name} tool cannot be used`);

      if (refusal) {
        return refusal;
      }
    }

    const { approved, reason } = await requestApproval(
      `OK to call ${chalk.bold(name)} with ${describeArgs(args)}?`,
      { kind: 'tool', value: name }
    );

    if (!approved) {
      return describeDenial(`call ${name}`, reason);
    }

    const result = await connection.callTool({
      name: tool.name,
      arguments: args
    });

    return truncate(describeResult(result), commandOutputBudget);
  };

  return { definition, handler };
};

// close() is still asked for, for a server that is reached over http
const stop = (connection: McpConnection) => {
  connection.kill?.();
  connection.close().catch(() => {});
};

// how a server's outcome reaches the screen - at startup a spinner has to
// step aside for it, everywhere else it is simply written
type Report = (write: () => void) => void;

// one server's tools, or none if it fails - the failure is recorded on its
// status and goes no further, so it cannot cost the other servers theirs
const connectServer = async (
  name: string,
  server: McpServerConfig,
  connect: Connect,
  timeout: number,
  status: McpServerStatus,
  report: Report = (write) => write()
): Promise<ToolCall[]> => {
  status.tools = 0;
  delete status.error;

  const connecting = connect(name, server);

  try {
    const [connection, tools] = await withTimeout(
      connecting.then(async (connection) => {
        const tools = await listAll(connection);

        return [connection, tools] as const;
      }),
      timeout,
      `Connecting to ${name}`
    );

    const calls = tools.map((tool) => toToolCall(name, tool, connection));

    connections.set(name, connection);
    serverTools.set(name, calls);
    status.tools = tools.length;
    report(() =>
      log.info(
        chalk.gray(`Connected to MCP server ${name} (${tools.length} tools)`)
      )
    );

    return calls;
  } catch (error) {
    status.error = describeError(error);
    report(() =>
      log.warn(`Could not use MCP server ${name} - ${status.error}`)
    );

    // a server that came up - before the failure, or only after the time ran
    // out - is still running, and nothing else will stop it
    connecting.then(stop, () => {});

    return [];
  }
};

// connects to every configured server at once, so a slow one costs its own
// timeout rather than everyone's. a server that fails is reported and left
// out - the rest are still offered, and the built-in tools are still a
// working agent without any of them
export const connectServers = async (
  servers: Record<string, McpServerConfig> = config.enabled
    ? config.servers
    : {},
  connect: Connect = connectClient,
  timeout = config.timeout
): Promise<ToolCall[]> => {
  statuses.length = 0;
  configured = servers;
  connector = connect;
  connectTimeout = timeout;

  // the servers still on their way up, which the spinner names
  const pending = new Set(
    Object.entries(servers)
      .filter(([, server]) => server.enabled !== false)
      .map(([name]) => name)
  );
  const describePending = () =>
    `Connecting to MCP server${pending.size === 1 ? '' : 's'} ${[...pending].join(', ')}`;
  const spinner = ora({
    stream: process.stdout,
    discardStdin: false,
    text: describePending()
  });
  const tty = Boolean(process.stdin.isTTY) && pending.size > 0;
  let stopClock = () => {};

  // the spinner owns the line it is drawn on, so it steps aside for each
  // outcome and comes back only while there is still something to wait for
  const reportFor =
    (name: string): Report =>
    (write) => {
      if (spinner.isSpinning) {
        spinner.stop();
      }

      write();
      pending.delete(name);
      spinner.text = describePending();

      if (tty && pending.size) {
        spinner.start();
      }
    };

  // every server is announced before any of them is waited on - connect()
  // runs up to its first await here, so none can have settled yet
  const connecting = Object.entries(servers).map(([name, server]) => {
    const status: McpServerStatus = {
      name,
      transport: server.url ? 'http' : 'stdio',
      tools: 0,
      enabled: server.enabled !== false
    };

    statuses.push(status);

    if (!status.enabled) {
      return [];
    }

    log.info(chalk.gray(`Starting MCP server ${name}`));

    return connectServer(
      name,
      server,
      connect,
      timeout,
      status,
      reportFor(name)
    );
  });

  if (tty) {
    spinner.start();
    stopClock = showElapsed(spinner);
  }

  try {
    return (await Promise.all(connecting)).flat();
  } finally {
    stopClock();

    if (spinner.isSpinning) {
      spinner.stop();
    }
  }
};

// the tools of every server that is connected now - what the model is offered
export const mcpTools = () => [...serverTools.values()].flat();

const findStatus = (name: string) => {
  const status = statuses.find((candidate) => candidate.name === name);

  if (!status || !configured[name]) {
    throw new Error(`There is no MCP server called ${name}`);
  }

  return status;
};

const disconnect = (name: string) => {
  const connection = connections.get(name);

  if (connection) {
    stop(connection);
  }

  connections.delete(name);
  serverTools.delete(name);
};

// starts one server over again - for one that failed, or timed out while it
// was still starting. whatever was running for it before is stopped first
export const retryServer = async (name: string) => {
  const status = findStatus(name);

  disconnect(name);
  await connectServer(
    name,
    configured[name],
    connector,
    connectTimeout,
    status
  );

  return status;
};

// turns a server on or off for this session, and saves that to config.yml so
// the runs that follow start the same way. a save that fails still leaves the
// change in place for this session, as /skills does
export const setServerEnabled = async (name: string, enabled: boolean) => {
  const status = findStatus(name);

  configured[name].enabled = enabled;
  status.enabled = enabled;

  try {
    saveSetting('mcp', ['servers', name, 'enabled'], enabled);
  } catch (error) {
    log.warn(
      `Could not save whether ${name} is enabled to config.yml - ${describeError(error)}`
    );
  }

  if (enabled) {
    return retryServer(name);
  }

  disconnect(name);
  status.tools = 0;
  delete status.error;

  return status;
};

// synchronous, since it runs from the exit handler alongside killAllJobs
export const closeServers = () => {
  for (const connection of connections.values()) {
    stop(connection);
  }

  connections.clear();
  serverTools.clear();
};
