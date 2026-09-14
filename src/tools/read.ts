import { readFileSync } from 'node:fs';

import { makeParameter, makeTool } from '../utils';

export const definition = makeTool('read', 'Reads an existing document', [
  makeParameter('string', 'path', 'Path to the document to read', true)
]);

type IArgs = {
  path: string;
};

export const handler = async ({ path }: IArgs) => readFileSync(path).toString();
