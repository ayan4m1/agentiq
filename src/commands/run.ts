import Bottleneck from 'bottleneck';

import { getLogger } from '../modules/logging';
import { performRoundOfThought } from '../modules/ollama';
import { ThoughtState } from '../types';
import { input } from '@inquirer/prompts';

const log = getLogger('run');
const rateLimiter = new Bottleneck({
  maxConcurrent: 1,
  minTime: 2000
});

log.info('Starting up...');

let nextThought: ThoughtState = {
  memory: {},
  messages: [
    {
      role: 'user',
      content: 'Save this piece of information in memory: "the apple is red".'
    }
  ]
};

let needsUserInput = true;
let roundsOfThought = 0;

while (true) {
  if (needsUserInput) {
    const userMessage = await input({
      message: '>',
      required: true
    });

    nextThought.messages.push({
      role: 'user',
      content: userMessage
    });

    needsUserInput = false;
  }

  nextThought = await rateLimiter.schedule(async () => {
    const result = await performRoundOfThought(nextThought);
    const latestThought = nextThought.messages[nextThought.messages.length - 1];

    roundsOfThought++;
    log.info(`Round ${roundsOfThought}`);

    needsUserInput = !(nextThought.lastResponse?.done ?? false);

    log.info(needsUserInput);
    log.info(latestThought.role);
    log.info(latestThought.content);

    return result;
  });
}
