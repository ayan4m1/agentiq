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
  messages: []
};

let needsUserInput = true;
let roundsOfThought = 0;

while (true) {
  if (needsUserInput) {
    const userMessage = await input({
      message: '>',
      required: true
    });

    if (userMessage.startsWith('/')) {
      switch (userMessage.substring(1)) {
        case 'quit':
          process.exit(0);
      }
    }

    nextThought.messages.push({
      role: 'user',
      content: userMessage
    });

    needsUserInput = false;
  }

  nextThought = await rateLimiter.schedule(async () => {
    const result = await performRoundOfThought(nextThought);
    const latestThought = result.lastResponse?.message;

    roundsOfThought++;
    log.info(`Round ${roundsOfThought}`);

    // keep thinking while the model is still calling tools - it is only the
    // user's turn again once a round comes back without any
    needsUserInput = !latestThought?.tool_calls?.length;

    if (latestThought?.content) {
      log.info(latestThought.content);
    }

    return result;
  });
}
