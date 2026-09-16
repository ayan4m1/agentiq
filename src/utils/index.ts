import { Tool } from 'ollama';
import { filesize } from 'filesize';
import { resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

import { ToolParameter } from '../types';
import { ollama } from '../modules/config';

// create an Ollama-compatible tool definition
export const makeTool = (
  name: string,
  description: string,
  parameters: ToolParameter[] = []
): Tool => ({
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
});

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

export const getTokenString = (value: number) =>
  filesize(value, {
    fullform: true,
    fullforms: ['Tokens', 'kTokens', 'mTokens', 'gTokens']
  });

// large files and HTML pages trivially exceed the context window, so tools cap
// their output at a fraction of it. 3.33 chars/token is a rough average that
// holds well enough across prose and code
export const getContentBudget = (fraction = 0.3) =>
  Math.floor(ollama.contextLimit * fraction * 3.33);

// tool results carry no record of the call that produced them, so say plainly
// that output was cut rather than letting the model assume it saw everything
export const truncate = (content: string, budget = getContentBudget()) =>
  content.length <= budget
    ? content
    : `${content.slice(0, budget)}\n\n[truncated: showing ${budget} of ${content.length} characters]`;

export const loadSystemPrompt = () => {
  const sysPromptPath = resolve(process.cwd(), 'AGENTIQ.md');
  if (existsSync(sysPromptPath)) {
    return readFileSync(sysPromptPath).toString();
  }
};

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
