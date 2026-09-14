import { Tool } from 'ollama';

import { ToolParameter } from '../types';

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
