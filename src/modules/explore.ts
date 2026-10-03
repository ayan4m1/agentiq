import ora from 'ora';
import chalk from 'chalk';

import { chatProvider } from '../providers';
import { explore as config, ollama, provider } from './config';
import { getLogger } from './logging';
import { recoverToolCalls, validateArgs } from './tools';
import { watchForInterrupt } from './interrupt';
import { showElapsed } from './elapsed';
import { resolveThink } from './preflight';
import { yieldToUser } from './turn';
import type { ChatMessage, ModelToolCall, ToolCall } from '../types';
import * as find from '../tools/find';
import * as list from '../tools/list';
import * as read from '../tools/read';
import * as fetch from '../tools/fetch';
import * as readPlan from '../tools/read_plan';
import {
  charsPerToken,
  describeElapsed,
  describeError,
  getContentBudget,
  serializeResult,
  truncate
} from '../utils';

const log = getLogger('explore');

// nothing here writes, runs a command or asks the user anything, so none of it
// needs approval and all of it is safe in plan mode. explore itself is left
// out, so an exploration can never start another one
export const readOnlyTools: ToolCall[] = [find, list, read, fetch, readPlan];

const definitions = readOnlyTools.map((tool) => tool.definition);
const toolNameList = definitions.map((definition) => definition.function.name!);
const toolNames = toolNameList.join(', ');

// a single read can hand back 30% of the context (see getContentBudget), so
// stopping here leaves room for one more result and the report after it
const budgetShare = 0.6;
// the report is what the main conversation keeps, so it has to stay small
// enough that exploring is cheaper than reading the files there
const reportBudget = getContentBudget(0.1);

const explorerPrompt = `You are exploring a codebase to answer one question for another agent, which will act on your answer. You cannot change anything: your only tools are ${toolNameList.map((name) => `\`${name}\``).join(', ')}.

- Start broad with \`find\` or \`list\`, then \`read\` only the parts that matter.
- Stop as soon as you can answer, and reply without calling a tool.
- Your reply is the report. Give the relevant file paths with line ranges, a short explanation of how they fit together, and only the snippets that matter. Never paste whole files. Say plainly if something could not be found.`;

const reportPrompt =
  'You have used up your exploration budget. Do not call any more tools. Write your report now from what you have found so far.';

const interruptedResult =
  'The user interrupted the exploration. Ask them how to continue rather than exploring again.';

const interruptHint = (elapsed: string) => `esc to interrupt (${elapsed})`;

// the tokenizer belongs to the main conversation, and this one is thrown away
// when it ends - so the same rough ratio the tool budgets use is close enough
const estimate = (messages: ChatMessage[]) =>
  Math.ceil(
    messages.reduce(
      (total, message) =>
        total +
        (message.content?.length ?? 0) +
        (message.tool_calls?.length
          ? JSON.stringify(message.tool_calls).length
          : 0),
      0
    ) / charsPerToken
  );

// one line per call, so the user can follow along without seeing the results
export const describeCall = (name: string, args?: Record<string, unknown>) => {
  const values = Object.values(args ?? {})
    .filter((value) => value !== undefined && value !== null && value !== '')
    .map((value) =>
      typeof value === 'string' ? value : JSON.stringify(value)
    );

  return `  > ${[name, ...values].join(' ')}`;
};

// each tool logs what it did in a line of its own, which beside the > line
// would say everything twice
const quietly = async <T>(name: string, work: () => T | Promise<T>) => {
  const logger = getLogger(name);
  const wasSilent = logger.silent;

  logger.silent = true;

  try {
    return await work();
  } finally {
    logger.silent = wasSilent;
  }
};

const runCall = async ({
  function: { name, arguments: args }
}: ModelToolCall) => {
  const tool = readOnlyTools.find(
    (candidate) => candidate.definition.function.name === name
  );

  if (!tool) {
    return `There is no tool called ${name} while exploring - nothing can be changed here. The available tools are: ${toolNames}`;
  }

  const validation = validateArgs(name, args);

  if (!validation.ok) {
    return validation.message ?? 'An unknown validation error occurred';
  }

  try {
    return serializeResult(
      await quietly(name, () => tool.handler(validation.args as never))
    );
  } catch (error) {
    return `The ${name} tool failed: ${describeError(error)}`;
  }
};

const finish = (content?: string) => {
  const report = content?.trim();

  return report
    ? truncate(report, reportBudget)
    : 'The exploration ended without a report.';
};

// answers a question in a conversation of its own, so that everything read on
// the way stays out of the main one - only the report comes back
export const explore = async (question: string) => {
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: `${explorerPrompt}\n\nThe working directory is ${process.cwd()}.`
    },
    { role: 'user', content: question }
  ];
  const rounds = config.rounds > 0 ? config.rounds : 1;
  const budget = Math.floor(provider.contextLimit * budgetShare);
  const spinner = ora({
    stream: process.stdout,
    // watchForInterrupt owns stdin in raw mode, as it does during a turn
    discardStdin: false,
    text: 'Exploring',
    suffixText: interruptHint(describeElapsed(0))
  });
  const tty = Boolean(process.stdin.isTTY);
  let stopClock = () => {};

  let interrupted = false;
  let interrupt!: () => void;
  const interruption = new Promise<undefined>((resolve) => {
    interrupt = () => resolve(undefined);
  });
  const stopWatching = watchForInterrupt(() => {
    interrupted = true;
    chatProvider.abort();
    interrupt();
  });

  // the spinner owns the line it is drawn on, so it steps aside for each call
  const print = (line: string) => {
    if (spinner.isSpinning) {
      spinner.stop();
    }

    console.log(chalk.gray(line));

    if (tty) {
      spinner.start();
    }
  };

  // raced against escape like a turn of the main conversation, since abort()
  // does not reach a request whose response has not started yet
  const ask = async (offerTools: boolean) => {
    const request = chatProvider.complete({
      model: provider.model,
      messages,
      tools: offerTools ? definitions : undefined,
      think: resolveThink()
    });

    // an interrupted request rejects once it is aborted, with nobody waiting
    request.catch(() => {});

    try {
      return await Promise.race([request, interruption]);
    } catch (error) {
      if (interrupted) {
        return;
      }

      throw error;
    }
  };

  if (tty) {
    spinner.start();
    stopClock = showElapsed(spinner, interruptHint);
  }

  try {
    for (let round = 1; round <= rounds; round++) {
      const reply = await ask(true);

      if (!reply) {
        break;
      }

      let calls = reply.tool_calls ?? [];
      let content = reply.content;

      if (!calls.length && ollama.recoverToolCalls && content) {
        const recovered = recoverToolCalls(content, toolNameList);

        if (recovered.calls.length) {
          calls = recovered.calls;
          content = recovered.remainder;
        }
      }

      if (!calls.length) {
        log.debug(`Explored for ${round} round(s)`);

        return finish(content);
      }

      // the text beside a call is narration rather than findings, and the
      // main conversation drops it for the same reason (see replayable()). a
      // provider that needs its reply back verbatim still has it in native
      messages.push({
        role: 'assistant',
        content: '',
        tool_calls: calls,
        ...(reply.native ? { native: reply.native } : {})
      });

      for (const call of calls) {
        print(describeCall(call.function.name, call.function.arguments));

        messages.push({
          role: 'tool',
          tool_name: call.function.name,
          ...(call.id ? { tool_call_id: call.id } : {}),
          content: await runCall(call)
        });

        if (interrupted) {
          break;
        }
      }

      if (interrupted) {
        break;
      }

      if (estimate(messages) > budget) {
        log.debug(`Exploration reached its budget after ${round} round(s)`);

        break;
      }
    }

    if (!interrupted) {
      messages.push({ role: 'user', content: reportPrompt });

      const reply = await ask(false);

      if (reply) {
        return finish(reply.content);
      }
    }

    // escape stops the whole turn, not only the exploration - the user wants
    // the keyboard back, not the model trying something else in its place
    yieldToUser();

    return interruptedResult;
  } finally {
    stopWatching();
    stopClock();

    if (spinner.isSpinning) {
      spinner.stop();
    }
  }
};
