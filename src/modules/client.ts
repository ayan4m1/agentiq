import { Ollama } from 'ollama';

import { ollama } from './config';

// one connection to the server, shared by everything that talks to it. it is
// its own module so that a startup check can reach ollama without pulling in
// the thinker and, through it, every tool
export const client = new Ollama({
  headers: ollama.bearerToken
    ? {
        Authorization: `Bearer ${ollama.bearerToken}`
      }
    : undefined,
  host: ollama.host
});
