import chalk from 'chalk';
import { filesize } from 'filesize';
import { structuredPatch } from 'diff';

import type {
  ChatMessage,
  ToolDefinition,
  ToolParameter,
  ToolResult
} from '../types';
import { chatProvider } from '../providers';
import { provider } from '../modules/config';

// a single call with no tools and no streaming - for asking the model something
// on the side, where the reply is used and never kept in the history
export const askModel = async (messages: ChatMessage[]) => {
  const reply = await chatProvider.complete({
    model: provider.model,
    messages
  });

  return reply.content;
};

// the schema handed to the model describes a parameter well enough for the model
// but not well enough to check an answer against, so keep the list that built
// it - the tool definitions stay the one place a parameter is declared
const declared = new Map<string, ToolParameter[]>();

export const getParameters = (name: string) => declared.get(name);

// create a tool definition
export const makeTool = (
  name: string,
  description: string,
  parameters: ToolParameter[] = []
): ToolDefinition => {
  declared.set(name, parameters);

  return {
    type: 'function',
    function: {
      name,
      description,
      parameters: {
        type: 'object',
        required: parameters
          .filter((param) => param.required)
          .map((param) => param.name),
        properties: Object.fromEntries(
          parameters.map((param) => [
            param.name,
            {
              type: param.type,
              description: param.description,
              ...(param.items ? { items: { type: param.items } } : {})
            }
          ])
        )
      }
    }
  };
};

// create a tool parameter definition
export const makeParameter = (
  type: string,
  name: string,
  description: string,
  required: boolean = true,
  items?: string
): ToolParameter => ({
  type,
  name,
  description,
  required,
  items
});

// rough relative time, for picking a session out of a list - "3h ago" says
// which conversation it was in a way a timestamp does not
// how many of the previous unit make up one of the next. days are not here
// because nothing rolls over into weeks - whatever is left is days
const scales: [number, string][] = [
  [60, 's'],
  [60, 'm'],
  [24, 'h']
];

export const describeAge = (timestamp: number) => {
  let value = Math.max((Date.now() - timestamp) / 1000, 0);

  for (const [size, unit] of scales) {
    if (value < size) {
      return `${Math.floor(value)}${unit} ago`;
    }

    value /= size;
  }

  return `${Math.floor(value)}d ago`;
};

// how long something has been running, to the second - "1m30s" rather than
// the single rounded unit describeAge settles for, since it ticks while shown
export const describeElapsed = (ms: number) => {
  let rest = Math.floor(Math.max(ms, 0) / 1000);
  let result = '';

  for (const [size, unit] of scales) {
    result = `${rest % size}${unit}${result}`;
    rest = Math.floor(rest / size);

    if (!rest) {
      return result;
    }
  }

  return `${rest}d${result}`;
};

export const getTokenString = (value: number, limit: number) =>
  `[${filesize(value, {
    fullform: true,
    fullforms: ['tok', 'kTok', 'mTok', 'gTok']
  })} (${Math.round((value / limit) * 1e2)}%)]`;

// the working directory goes into a file name, so anything that is not safe
// in one on every platform becomes a dash - C:/code/agentiq turns into
// C--code-agentiq. it can never contain an underscore, which is what lets a
// session id keep the slug and its uuid separable
export const slugFor = (cwd: string) => cwd.replace(/[^A-Za-z0-9]/g, '-');

// skills and custom commands both open with yaml frontmatter. it has to open
// the file - a --- further down is a horizontal rule in the body, not metadata
export const frontmatterPattern = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

// a rough average that holds well enough across prose and code. it sizes the
// budgets below, and stands in for a tokenizer when none is configured
export const charsPerToken = 3.33;

// large files and HTML pages trivially exceed the context window, so tools cap
// their output at a fraction of it
export const getContentBudget = (fraction = 0.3) =>
  Math.floor(provider.contextLimit * fraction * charsPerToken);

// what a command may hand back, whether it ran in the foreground or is still
// running in the background - one number so the two cannot drift apart
export const commandOutputBudget = getContentBudget(0.2);

// tool results carry no record of the call that produced them, so say plainly
// that output was cut rather than letting the model assume it saw everything
export const truncate = (content: string, budget = getContentBudget()) =>
  content.length <= budget
    ? content
    : `${content.slice(0, budget)}\n\n[truncated: showing ${budget} of ${content.length} characters]`;

// extract error message from error object
export const describeError = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

// a result with images to go along with its text, rather than a value to be
// serialized - only a tool that means to send images returns one
export const isToolResult = (result: unknown): result is ToolResult =>
  typeof result === 'object' &&
  result !== null &&
  typeof (result as ToolResult).content === 'string' &&
  Array.isArray((result as ToolResult).images);

// only JSON-encode results that are not already strings
export const serializeResult = (result: unknown): string => {
  if (result === undefined || result === null) {
    return 'The tool returned no output.';
  }

  return typeof result === 'string' ? result : JSON.stringify(result);
};

// the whole file on a colored background buries the change it is meant to show,
// so render only the hunks that were actually touched. shared rather than
// private to the patch tool because the roadmap tools write without asking, so
// this diff is the only account the user gets of what changed
// one walk over the hunks for both the colored diff the user sees and the plain
// one the model is handed, so the two cannot come to disagree
const diffLines = (path: string, before: string, after: string) => {
  const { hunks } = structuredPatch(path, path, before, after, '', '', {
    context: 3
  });

  return hunks.flatMap((hunk) => [
    `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
    ...hunk.lines
  ]);
};

const colorLine = (line: string) => {
  if (line.startsWith('@@')) {
    return chalk.cyan(line);
  }

  if (line.startsWith('+')) {
    return chalk.green(line);
  }

  if (line.startsWith('-')) {
    return chalk.red(line);
  }

  return chalk.gray(line);
};

export const renderDiff = (path: string, before: string, after: string) => {
  for (const line of diffLines(path, before, after)) {
    console.log(colorLine(line));
  }
};

// the same hunks without color, for telling the model what changed
export const describeDiff = (path: string, before: string, after: string) =>
  diffLines(path, before, after).join('\n');
