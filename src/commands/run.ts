import { getLogger } from 'modules/logging.js';
import { performRoundOfThought } from 'modules/ollama.js';
import { ThoughtState } from 'types/index.js';

const log = getLogger('run');

log.info('Starting up...');

let nextThought: ThoughtState = {
  memory: {},
  messages: []
};

while (true) {
  nextThought = await performRoundOfThought(nextThought);

  const latestThought = nextThought.messages[nextThought.messages.length - 1];

  log.info(latestThought.content);
}
