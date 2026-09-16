import { Tool } from 'ollama';

import { ToolParameter } from '../types';
import { filesize } from 'filesize';

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
            description: param.description
          }
        ])
      )
    }
  }
});

export const makeParameter = (
  type: string,
  name: string,
  description: string,
  required: boolean = true
): ToolParameter => ({
  type,
  name,
  description,
  required
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
