import inquirer from 'inquirer';
import Bottleneck from 'bottleneck';
import { resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import InquirerCommandPrompt from 'inquirer-command-prompt';

import { tools } from '../tools';
import { getLogger } from '../modules/logging';
import { makeThinker } from '../modules/ollama';
import { ThoughtState } from '../types';

inquirer.registerPrompt('command', InquirerCommandPrompt);

const log = getLogger('run');
const rateLimiter = new Bottleneck({
  maxConcurrent: 1,
  minTime: 1000
});

log.info(`Loaded ${tools.length} tools`);

let systemPrompt: string | undefined;

const sysPromptPath = resolve(process.cwd(), 'AGENTIQ.md');
if (existsSync(sysPromptPath)) {
  log.debug(`Reading system prompt from ${sysPromptPath}`);

  systemPrompt = readFileSync(sysPromptPath).toString();
}

const thinker = makeThinker({ tools, systemPrompt });

let nextThought: ThoughtState = {
  messages: []
};

let needsUserInput = true;
let roundsOfThought = 0;

while (true) {
  if (needsUserInput) {
    //@ts-expect-error saveHistory must be a bool but inquirer doesn't allow that
    const { userMessage } = await inquirer.prompt({
      type: 'command',
      name: 'userMessage',
      message: '>',
      saveHistory: true
    });

    if (userMessage.startsWith('/')) {
      switch (userMessage.substring(1)) {
        case 'context':
          // todo: set a system prompt and tokenize it to get its length here
          log.info(`{SYSTEM   } - ${thinker.tokens.system} tokens`);
          // todo: when tool calls are made, this should increase
          log.info(`{TOOLS    } - ${thinker.tokens.tools} tokens`);
          // count of tokens in back/forth messages
          log.info(`{MESSAGES } - ${thinker.tokens.messages} tokens`);
          // total token count for this session
          log.info(`{TOTAL    } - ${thinker.tokens.total} tokens`);
          break;
        case 'quit':
          process.exit(0);
      }

      continue;
    }

    nextThought.messages.push({
      role: 'user',
      content: userMessage
    });

    needsUserInput = false;
  }

  nextThought = await rateLimiter.schedule(async () => {
    const result = await thinker.think(nextThought);
    const latestThought = result.lastResponse?.message;

    roundsOfThought++;

    log.info(`Round ${roundsOfThought} - ${thinker.tokens.total} tokens`);

    // keep thinking while the model is still calling tools - it is only the
    // user's turn again once a round comes back without any
    needsUserInput = !latestThought?.tool_calls?.length;

    if (latestThought?.content) {
      log.info(latestThought.content);
    }

    return result;
  });
}
