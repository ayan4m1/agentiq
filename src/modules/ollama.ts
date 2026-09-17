import chalk from 'chalk';
import { Message, Ollama } from 'ollama';
import { clearLine, cursorTo } from 'node:readline';

import { ollama } from './config';
import { getLogger } from './logging';
import { makeTokenizer } from './tokenizer';
import { validateArgs } from './validate';
import { watchForInterrupt } from './interrupt';
import { ThoughtState, TokenStats } from '../types';
import { tools } from '../tools';
import { describeError, loadSystemPrompt, serializeResult } from '../utils';

const log = getLogger('ollama');
const client = new Ollama({
  headers: ollama.bearerToken
    ? {
        Authorization: `Bearer ${ollama.bearerToken}`
      }
    : undefined,
  host: ollama.host
});

const summaryPrompt =
  "Summarize the conversation so far. Preserve the user's goals, every decision made, the paths of files read or changed, and any work still outstanding. Write it as notes for yourself, not as a reply to the user.";

export const makeThinker = () => {
  const systemPrompt = loadSystemPrompt();
  const tokenizer = makeTokenizer();
  const toolDefs = tools.map((tool) => tool.definition);
  const toolNames = toolDefs.map((toolDef) => toolDef.function.name).join(', ');
  const tokens: TokenStats = {
    messages: 0,
    system: 0,
    tools: 0,
    total: 0
  };
  let turnCount = 0;
  let aborted = false;

  // think() is re-entered with the array it returned last turn, so track which
  // messages have already been counted
  let counted = new WeakSet<Message>();

  // a tool call's arguments are part of what gets sent back every turn
  const measure = (message: Message) =>
    tokenizer(message.content ?? '') +
    (message.tool_name ? tokenizer(message.tool_name) : 0) +
    (message.tool_calls?.length
      ? tokenizer(JSON.stringify(message.tool_calls))
      : 0);

  // get the complete token cost of a message
  const countMessage = (message: Message) => {
    if (message.role === 'system' || counted.has(message)) {
      return 0;
    }

    counted.add(message);

    const cost = measure(message);

    tokens.messages += cost;
    tokens.total += cost;

    return cost;
  };

  // compaction replaces message objects outright, so the incremental counter
  // cannot be trusted afterwards - start its bookkeeping over
  const recount = (messages: Message[]) => {
    counted = new WeakSet<Message>();
    tokens.total -= tokens.messages;
    tokens.messages = 0;

    for (const message of messages) {
      countMessage(message);
    }

    return tokens.messages;
  };

  log.debug(`Loaded ${tools.length} tools`);
  log.debug(`Context limit is ${ollama.contextLimit} tokens`);

  if (systemPrompt) {
    const sysPromptCost = tokenizer(systemPrompt);

    log.debug(`System prompt will consume ${sysPromptCost} tokens`);

    tokens.system += sysPromptCost;
    tokens.total += sysPromptCost;
  }

  for (const tool of tools) {
    const toolCost = tokenizer(JSON.stringify(tool.definition));

    log.debug(
      `Definition for ${tool.definition.function.name} will consume ${toolCost} tokens`
    );

    tokens.tools += toolCost;
    tokens.total += toolCost;
  }

  const think = async (lastState: ThoughtState): Promise<ThoughtState> => {
    let messages: Message[] = [...lastState.messages];

    if (systemPrompt && messages[0]?.role !== 'system') {
      messages = [{ role: 'system', content: systemPrompt }, ...messages];
    }

    turnCount++;
    aborted = false;

    // the hint holds only while it is still the current line - the first token
    // of output scrolls it out of reach - so whoever writes next clears it
    let hintShown = false;

    const clearHint = () => {
      if (!hintShown) {
        return;
      }

      hintShown = false;
      clearLine(process.stdout, 0);
      cursorTo(process.stdout, 0);
    };

    if (process.stdin.isTTY) {
      process.stdout.write(chalk.dim('esc to interrupt'));
      hintShown = true;
    }

    const stream = await client.chat({
      model: ollama.model,
      messages,
      tools: toolDefs,
      stream: true,
      keep_alive: ollama.keepAlive,
      // without this ollama falls back to the model default - often 4096 - and
      // silently truncates the prompt, dropping messages the model needs
      options: {
        num_ctx: ollama.contextLimit
      }
    });

    const assistantMessage: Message = { role: 'assistant', content: '' };
    let wroteOutput = false;
    let lastChunk;

    process.stdout.write('\n');

    const stopWatching = watchForInterrupt(abort);

    // enter a read/print loop of text chunks from the model
    try {
      for await (const chunk of stream) {
        lastChunk = chunk;

        if (chunk.message?.content) {
          clearHint();
          process.stdout.write(chalk.blue(chunk.message.content));

          assistantMessage.content += chunk.message.content;
          wroteOutput = true;
        }

        if (chunk.message?.tool_calls?.length) {
          assistantMessage.tool_calls = [
            ...(assistantMessage.tool_calls ?? []),
            ...chunk.message.tool_calls
          ];
        }
      }
    } catch (error) {
      // an abort surfaces here as a rejected iterator - anything else is a real
      // failure and belongs to the caller
      if (!aborted) {
        throw error;
      }
    } finally {
      stopWatching();
      // a turn that only made tool calls, or one that ended before saying
      // anything, never wrote over the hint
      clearHint();
    }

    if (wroteOutput) {
      process.stdout.write('\n\n');
    }

    // a half-streamed message can carry a truncated tool call, and dispatching
    // it would push a result for a call the model never finished making. roll
    // the whole turn back instead and let the user pick up from the last good
    // state.
    if (aborted) {
      log.debug(`Round ${turnCount} interrupted`);

      return { ...lastState, interrupted: true };
    }

    if (lastChunk?.eval_count && lastChunk?.eval_duration) {
      // eval_duration is measured in nanoseconds
      const rate = Math.round(
        lastChunk.eval_count / (lastChunk.eval_duration / 1e9)
      );

      log.debug(`Generated ${lastChunk.eval_count} tokens at ${rate} tok/s`);
    }

    // append message before tool results
    messages.push(assistantMessage);

    // execute and append tool call results, if any
    for (const toolCall of assistantMessage.tool_calls ?? []) {
      const { name, arguments: args } = toolCall.function;
      const tool = tools.find(
        (candidate) => candidate.definition.function.name === name
      );
      let content: string;

      if (!tool) {
        log.warn(`Asked to use an unknown tool called ${name}`);

        content = `There is no tool called ${name}. The available tools are: ${toolNames}`;
      } else {
        // arguments are untyped JSON from the model, so they are checked here
        // rather than in every handler - a malformed call comes back as a
        // message the model can correct instead of an exception
        const validation = validateArgs(name, args);

        if (!validation.ok) {
          log.warn(`Rejected a malformed call to ${name}`);

          content =
            validation.message ?? 'An unknown validation error occurred';
        } else {
          try {
            content = serializeResult(
              await tool.handler(validation.args as never)
            );
          } catch (error) {
            const message = describeError(error);

            log.error(
              chalk.red(`The ${name} tool threw an error - ${message}`)
            );

            content = `The ${name} tool failed: ${message}`;
          }
        }
      }

      // every tool call needs a result, even a failed one - leaving one
      // dangling makes the next request an incomplete conversation
      messages.push({
        role: 'tool',
        tool_name: name,
        content
      });
    }

    const turnCost = messages.reduce(
      (total, message) => total + countMessage(message),
      0
    );

    log.debug(`Turn cost ${turnCost} tokens`);

    // the final chunk carries an empty message, but callers expect the response
    // to hold what the model actually said - including any tool calls
    if (lastChunk) {
      lastChunk.message = assistantMessage;
    }

    return {
      lastResponse: lastChunk,
      messages
    };
  };

  // replace the older part of the conversation with a summary of it, so a long
  // session degrades into notes rather than reaching num_ctx and being silently
  // truncated by ollama
  const compact = async (messages: Message[]) => {
    // measure the array we were handed rather than trusting the running total.
    // it is the only baseline guaranteed to describe these exact messages, and
    // comparing against a stale one makes the check below fire at random
    const before = recount(messages);
    // cutting mid-turn would orphan a tool result from the call that produced
    // it, so split on the last user message - everything from there is intact
    const splitAt = messages.findLastIndex(
      (message) => message.role === 'user'
    );

    if (splitAt < 1) {
      return { messages, freed: 0 };
    }

    const older = messages.slice(0, splitAt);
    const recent = messages.slice(splitAt);
    // no tools on this call - the model is writing notes, not taking another
    // turn, and offering it tools invites it to start working again
    const response = await client.chat({
      model: ollama.model,
      messages: [...older, { role: 'user', content: summaryPrompt }],
      keep_alive: ollama.keepAlive,
      options: {
        num_ctx: ollama.contextLimit
      }
    });
    const compacted: Message[] = [
      {
        role: 'user',
        content: `Here are notes on everything that happened earlier in this conversation:\n\n${response.message.content}`
      },
      ...recent
    ];

    recount(compacted);

    // a summary of a short exchange can easily come back longer than the turns
    // it replaced. keeping it would both waste context and leave the caller
    // above its threshold, so it would ask again next turn and never stop
    if (tokens.messages >= before) {
      log.warn(
        `Summary was no smaller than the ${older.length} messages it replaced - keeping them`
      );

      recount(messages);

      return { messages, freed: 0 };
    }

    return { messages: compacted, freed: before - tokens.messages };
  };

  // adopt a conversation that was not built by think() - a resumed session -
  // so the token stats describe the history the model is about to be sent
  const load = (messages: Message[]) => {
    turnCount = 0;

    return recount(messages);
  };

  // drop the conversation from the running totals, leaving the system prompt
  // and tool definitions - they are still sent on every turn
  const reset = () => {
    const freed = tokens.messages;

    recount([]);
    turnCount = 0;

    return freed;
  };

  // only meaningful mid-turn: escape during generation cancels the in-flight
  // stream so think() can roll the turn back, leaving the conversation intact
  const abort = () => {
    aborted = true;
    client.abort();
  };

  return {
    think,
    load,
    reset,
    compact,
    abort,
    tokens,
    get turnCount() {
      return turnCount;
    }
  };
};
