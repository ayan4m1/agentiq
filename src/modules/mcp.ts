import chalk from 'chalk';
import { execFileSync } from 'node:child_process';
// the sdk publishes these through a "./*" wildcard export, which node and tsc
// follow but the lint resolver does not
/* eslint-disable import-x/no-unresolved */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
/* eslint-enable import-x/no-unresolved */

import { mcp as config } from './config';
import { getLogger } from './logging';
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
};

export type Connect = (
  name: string,
  server: McpServerConfig
) => Promise<McpConnection>;

const prefix = 'mcp__';

const connections = new Map<string, McpConnection>();
const statuses: McpServerStatus[] = [];

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

// connects to every configured server at once, so a slow one costs its own
// timeout rather than everyone's. a server that fails is reported and left
// out - the built-in tools are still a working agent without it
export const connectServers = async (
  servers: Record<string, McpServerConfig> = config.enabled
    ? config.servers
    : {},
  connect: Connect = connectClient,
  timeout = config.timeout
): Promise<ToolCall[]> => {
  statuses.length = 0;

  const results = await Promise.all(
    Object.entries(servers).map(async ([name, server]) => {
      const status: McpServerStatus = {
        name,
        transport: server.url ? 'http' : 'stdio',
        tools: 0
      };

      statuses.push(status);

      let connection: McpConnection | undefined;

      try {
        const tools = await withTimeout(
          (async () => {
            connection = await connect(name, server);

            return listAll(connection);
          })(),
          timeout,
          `Connecting to ${name}`
        );

        connections.set(name, connection!);
        status.tools = tools.length;
        log.info(
          chalk.gray(`Connected to MCP server ${name} (${tools.length} tools)`)
        );

        return tools.map((tool) => toToolCall(name, tool, connection!));
      } catch (error) {
        status.error = describeError(error);
        log.warn(`Could not use MCP server ${name} - ${status.error}`);

        // one that connected but then failed or ran out of time is still
        // running, and nothing else will stop it
        connection?.kill?.();
        connection?.close().catch(() => {});

        return [];
      }
    })
  );

  return results.flat();
};

// synchronous, since it runs from the exit handler alongside killAllJobs -
// close() is still asked for, for a server that is reached over http
export const closeServers = () => {
  for (const connection of connections.values()) {
    connection.kill?.();
    connection.close().catch(() => {});
  }

  connections.clear();
};
