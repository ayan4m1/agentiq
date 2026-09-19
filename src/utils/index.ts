import type { Tool } from 'ollama';
import { filesize } from 'filesize';

import type { ToolParameter } from '../types';
import { ollama } from '../modules/config';

// the schema handed to ollama describes a parameter well enough for the model
// but not well enough to check an answer against, so keep the list that built
// it - the tool definitions stay the one place a parameter is declared
const declared = new Map<string, ToolParameter[]>();

export const getParameters = (name: string) => declared.get(name);

// create an Ollama-compatible tool definition
export const makeTool = (
  name: string,
  description: string,
  parameters: ToolParameter[] = []
): Tool => {
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

// create an Ollama-compatible tool parameter definition
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

export const getTokenString = (value: number) =>
  `[${filesize(value, {
    fullform: true,
    fullforms: ['tok', 'kTok', 'mTok', 'gTok']
  })}]`;

// a rough average that holds well enough across prose and code. it sizes the
// budgets below, and stands in for a tokenizer when none is configured
// the working directory goes into a file name, so anything that is not safe
// in one on every platform becomes a dash - C:/code/agentiq turns into
// C--code-agentiq. it can never contain an underscore, which is what lets a
// session id keep the slug and its uuid separable
export const slugFor = (cwd: string) => cwd.replace(/[^A-Za-z0-9]/g, '-');

export const charsPerToken = 3.33;

// large files and HTML pages trivially exceed the context window, so tools cap
// their output at a fraction of it
export const getContentBudget = (fraction = 0.3) =>
  Math.floor(ollama.contextLimit * fraction * charsPerToken);

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

// only JSON-encode results that are not already strings
export const serializeResult = (result: unknown): string => {
  if (result === undefined || result === null) {
    return 'The tool returned no output.';
  }

  return typeof result === 'string' ? result : JSON.stringify(result);
};
