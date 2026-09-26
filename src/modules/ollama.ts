import ora from 'ora';
import chalk from 'chalk';
import type { Message } from 'ollama';

import { client } from './client';
import { ollama, session } from './config';
import { describeElision, findSplit, isElided, pairCalls } from './compaction';
import { getLogger } from './logging';
import { makeTokenizer } from './tokenizer';
import { recoverToolCalls, validateArgs } from './tools';
import { recapPrompt, recentTurns, renderTranscript } from './recap';
import { buildSystemPrompt } from './prompt';
import { describeSkills } from './skills';
import { watchForInterrupt } from './interrupt';
import { supportsThinking } from './preflight';
import type { AgentMessage, ThoughtState, TokenStats } from '../types';
import { tools } from '../tools';
import { describeElapsed, describeError, serializeResult } from '../utils';

const log = getLogger('ollama');

const interruptHint = (ms: number) =>
  `esc to interrupt (${describeElapsed(ms)})`;

// compacting on the way to the limit rather than at it leaves room for the
// summarization call itself, which still has to fit in the same window
export const compactThreshold = 0.8;
// and it aims well below the trigger, so the turns that follow do not cross it
// again straight away and pay for another round each time
const compactTarget = 0.5;

// an explicit setting wins, including an explicit false. otherwise a model
// that reports it can reason is asked to, because the alternative is that it
// reasons anyway and buries the result in its reply - where it is streamed as
// though it were the answer, and then re-sent on every turn that follows
const resolveThink = () => {
  if (ollama.think !== undefined) {
    return ollama.think;
  }

  return supportsThinking() ? true : undefined;
};

// what is left of a finished turn once it is history rather than output. the
// preamble a model writes on its way to a tool call has already been streamed
// to the user, and sending it back alongside the call is what ollama's gemma
// renderer turns into a prompt that reads as already answered - the round after
// it comes back as a single end token and nothing else. the call is the part
// that has to survive, so unless AQ_OLLAMA_REPLAY_PREAMBLE says otherwise the
// text goes the way the reasoning already does. a turn that neither spoke nor
// called anything has nothing to replay whatever that setting says
export const replayable = (message: Message, replayPreamble: boolean) => {
  if (message.tool_calls?.length) {
    return replayPreamble ? message : { ...message, content: '' };
  }

  return message.content?.trim() ? message : undefined;
};

const summaryPrompt =
  "Summarize the conversation so far. Preserve the user's goals, every decision made, the paths of files read or changed, and any work still outstanding. Write it as notes for yourself, not as a reply to the user.";

export const makeThinker = () => {
  let systemPrompt = buildSystemPrompt();
  let tokenizer = makeTokenizer();
  const toolDefs = tools.map((tool) => tool.definition);
  const toolNameList = toolDefs.map((toolDef) => toolDef.function.name!);
  const toolNames = toolNameList.join(', ');
  const tokens: TokenStats = {
    messages: 0,
    system: 0,
    skills: 0,
    tools: 0,
    total: 0,
    // until ollama has answered once, every number here is a tokenizer estimate
    measured: false
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

  // ollama counts the prompt it actually rendered - chat template scaffolding,
  // tool schemas, special tokens and all - which is the number it compares
  // against num_ctx before it decides to truncate. our own figure is a
  // tokenizer's guess at the same thing, and the tokenizer may not even be the
  // model's, so once the server has spoken believe it over the estimate
  const reconcile = (promptTokens: number, messagesAtSend: number) => {
    // the count describes the prompt as it was sent, so whatever the turn
    // appended afterwards - the reply and its tool results - is still estimated
    const appendedSinceSend = tokens.messages - messagesAtSend;
    const grounded = promptTokens + appendedSinceSend;
    const drift = grounded - tokens.total;

    if (drift) {
      log.debug(
        `Corrected the context estimate by ${drift} token(s) - ollama counted ${promptTokens} in the prompt`
      );
    }

    tokens.total = grounded;
    tokens.measured = true;
  };

  // the parts of the prompt that are sent whatever the conversation holds
  const fixedCost = () => tokens.system + tokens.skills + tokens.tools;

  // what every turn pays before a single message is sent. it is counted here
  // rather than inline so that rebuild() can count it again with a different
  // tokenizer and the two can never disagree about what they measured
  const countFixed = () => {
    tokens.system = 0;
    tokens.skills = 0;
    tokens.tools = 0;

    if (systemPrompt) {
      const skills = describeSkills();

      // the skills are sent inside the system prompt, so their cost is taken
      // out of it rather than added to it - otherwise they would be counted
      // twice. measuring the parts apart can differ from the whole by a token
      // at the seam, which an estimate can live with
      if (skills) {
        tokens.skills = tokenizer(skills);

        log.debug(`Skills will consume ${tokens.skills} tokens`);
      }

      const sysPromptCost = tokenizer(systemPrompt) - tokens.skills;

      log.debug(`System prompt will consume ${sysPromptCost} tokens`);

      tokens.system = sysPromptCost;
    }

    for (const tool of tools) {
      const toolCost = tokenizer(JSON.stringify(tool.definition));

      log.debug(
        `Definition for ${tool.definition.function.name} will consume ${toolCost} tokens`
      );

      tokens.tools += toolCost;
    }

    tokens.total = fixedCost() + tokens.messages;
  };

  log.debug(`Loaded ${tools.length} tools`);
  log.debug(`Context limit is ${ollama.contextLimit} tokens`);

  countFixed();

  const think = async (lastState: ThoughtState): Promise<ThoughtState> => {
    let messages: Message[] = [...lastState.messages];

    if (systemPrompt && messages[0]?.role !== 'system') {
      messages = [{ role: 'system', content: systemPrompt }, ...messages];
    }

    turnCount++;
    aborted = false;

    // the spinner holds only while it is still the current line - the first
    // token of output takes it over - so whoever writes next stops it
    const spinner = ora({
      stream: process.stdout,
      // watchForInterrupt owns stdin in raw mode for the turn, and ora's own
      // discard would fight it for the escape byte
      discardStdin: false,
      suffixText: interruptHint(0)
    });
    // counts up beside the hint, so a model slow to load or to answer shows
    // how long it has been at it
    let clock: NodeJS.Timeout | undefined;

    const stopSpinner = () => {
      clearInterval(clock);

      if (spinner.isSpinning) {
        spinner.stop();
      }
    };

    // separate the reply from the prompt before anything claims the line -
    // a write while the spinner runs would break its redraw
    process.stdout.write('\n');

    if (process.stdin.isTTY) {
      spinner.start();

      const startedAt = Date.now();

      // ora redraws on its own frame timer, which picks up the new text
      clock = setInterval(() => {
        spinner.suffixText = interruptHint(Date.now() - startedAt);
      }, 1000).unref();
    }

    const assistantMessage: Message = { role: 'assistant', content: '' };
    let wroteOutput = false;
    let lastChunk;

    // counting before the call rather than only after it gives reconcile() a
    // baseline that covers exactly the messages ollama is about to be shown
    for (const message of messages) {
      countMessage(message);
    }

    const messagesAtSend = tokens.messages;
    // client.abort() only reaches a request once its response has arrived, and
    // a model still loading can hold that back for a minute - so escape also
    // settles this, and the turn stops waiting on the request at all
    let interrupt!: () => void;
    const interrupted = new Promise<undefined>((resolve) => {
      interrupt = () => resolve(undefined);
    });
    const stopWatching = watchForInterrupt(() => {
      abort();
      interrupt();
    });

    // the request itself is inside the try too - a failed connection must
    // still hand stdin back
    try {
      const request = client.chat({
        model: ollama.model,
        messages,
        tools: toolDefs,
        stream: true,
        think: resolveThink(),
        keep_alive: ollama.keepAlive,
        // without this ollama falls back to the model default - often 4096 -
        // and silently truncates the prompt, dropping messages the model needs
        options: {
          num_ctx: ollama.contextLimit
        }
      });
      const stream = await Promise.race([request, interrupted]);

      if (!stream) {
        // escape beat the response. close it the moment it does arrive, so
        // ollama sees the disconnect and never generates the reply - and a
        // request that fails instead has nobody left to hear about it
        request.then(
          (late) => late.abort(),
          () => {}
        );
        log.debug(`Round ${turnCount} interrupted before the model answered`);

        return { ...lastState, interrupted: true };
      }

      // enter a read/print loop of text chunks from the model
      for await (const chunk of stream) {
        lastChunk = chunk;

        // reasoning arrives in its own field when the model separates it, and
        // is deliberately not kept: it describes how this one answer was
        // reached, and re-sending it on every later turn buys nothing
        if (chunk.message?.thinking) {
          stopSpinner();

          process.stdout.write(chalk.gray(chunk.message.thinking));
        }

        if (chunk.message?.content) {
          stopSpinner();

          // put the answer on its own, rather than running it straight on from
          // the reasoning that led to it
          if (chunk.message?.thinking && !wroteOutput) {
            process.stdout.write('\n\n');
          }

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
      // anything, never wrote over the spinner
      stopSpinner();
    }

    // a turn that only reasoned before calling a tool still has to close the
    // line it was writing on
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

    // a model served with a template that does not know its tool call format
    // writes its calls into the reply, and a turn with no calls ends. pull them
    // back out so they are dispatched - and validated - like any other call.
    // the caller keeps what was actually said; history keeps only the prose,
    // since the calls now travel as calls
    let replaySource = assistantMessage;

    if (
      ollama.recoverToolCalls &&
      !assistantMessage.tool_calls?.length &&
      assistantMessage.content
    ) {
      const { calls, remainder } = recoverToolCalls(
        assistantMessage.content,
        toolNameList
      );

      if (calls.length) {
        log.info(
          `Recovered ${calls.length} tool call(s) the model wrote as text`
        );

        assistantMessage.tool_calls = calls;
        replaySource = { ...assistantMessage, content: remainder };
      }
    }

    // append message before tool results
    const replay = replayable(replaySource, ollama.replayPreamble);

    if (replay) {
      messages.push(replay);
    } else {
      // nothing was streamed either, so the round would otherwise end without
      // a single character to explain why
      log.debug(chalk.red('The model returned an empty response'));
    }

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

    const tokenCount = messages.reduce(
      (total, message) => total + countMessage(message),
      0
    );

    log.debug(`Context grew by ${tokenCount} tokens`);

    if (lastChunk?.prompt_eval_count) {
      reconcile(lastChunk.prompt_eval_count, messagesAtSend);
    }

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

  // the cheapest tier: a long run fills its window with tool output - files
  // read, commands run - and dropping the oldest of it costs nothing but the
  // text itself. the message stays where it is so that call and result remain
  // paired and the conversation stays well formed
  const elideToolResults = (messages: Message[], target: number) => {
    const calls = pairCalls(messages);
    const startedAt = tokens.total;
    let projected = tokens.total;
    let count = 0;

    for (const [index, message] of messages.entries()) {
      if (projected <= target) {
        break;
      }

      if (message.role !== 'tool' || !message.content || isElided(message)) {
        continue;
      }

      const was = measure(message);

      message.content = describeElision(
        message.content,
        message.tool_name,
        calls.get(index)
      );
      projected -= was - measure(message);
      count++;
    }

    if (!count) {
      return 0;
    }

    // the contents changed underneath the per-message cache, so the counts
    // have to be rebuilt before any of them are trusted again
    recount(messages);
    log.debug(`Elided ${count} tool result(s)`);

    return startedAt - tokens.total;
  };

  // replace the older part of the conversation with a summary of it, so a long
  // session degrades into notes rather than reaching num_ctx and being silently
  // truncated by ollama
  const summarize = async (messages: Message[], before: number) => {
    // cutting mid-turn would orphan a tool result from the call that produced
    // it, so the split has to land where nothing straddles it
    const splitAt = findSplit(messages);

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
    const compacted: AgentMessage[] = [
      {
        role: 'user',
        content: `Here are notes on everything that happened earlier in this conversation:\n\n${response.message.content}`,
        summary: true
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

  // cheapest first: drop old tool output, and only pay for a summarization
  // call if that was not enough. either tier freeing something is what keeps
  // the caller from deciding that nothing can be done
  const compact = async (messages: Message[]) => {
    // measure the array we were handed rather than trusting the running total.
    // it is the only baseline guaranteed to describe these exact messages
    recount(messages);

    const target = Math.floor(ollama.contextLimit * compactTarget);
    const before = tokens.total;
    const elided = elideToolResults(messages, target);

    if (tokens.total <= target) {
      return { messages, freed: elided };
    }

    // measured against the messages as they stand now, which is what the
    // summary will be compared with
    const summarized = await summarize(messages, tokens.messages);

    return {
      messages: summarized.messages,
      // a summary that came back no smaller still leaves whatever tier one
      // reclaimed, and that is real progress rather than a dead end
      freed: summarized.freed ? before - tokens.total : elided
    };
  };

  // a few lines for the user on what the last few turns were about. it is only
  // ever printed, so nothing here is counted - and a failure is only a warning,
  // since a recap is never worth losing the conversation over
  const recap = async (messages: Message[], turns = session.recapTurns) => {
    const transcript = renderTranscript(recentTurns(messages, turns));

    if (!transcript) {
      return;
    }

    const spinner = ora({
      stream: process.stdout,
      discardStdin: false,
      text: 'Recapping'
    });

    if (process.stdin.isTTY) {
      spinner.start();
    }

    try {
      // one user message holding the whole excerpt, rather than the messages
      // themselves - there are no tool calls left in it to pair results with,
      // and no tools are offered, since the model is not meant to act on it
      const response = await client.chat({
        model: ollama.model,
        messages: [
          { role: 'user', content: `${recapPrompt}\n\n${transcript}` }
        ],
        keep_alive: ollama.keepAlive,
        options: {
          num_ctx: ollama.contextLimit
        }
      });

      return response.message.content.trim() || undefined;
    } catch (error) {
      log.warn(`Could not recap the session: ${describeError(error)}`);

      return;
    } finally {
      if (spinner.isSpinning) {
        spinner.stop();
      }
    }
  };

  // adopt a conversation that was not built by think() - a resumed session -
  // so the token stats describe the history the model is about to be sent
  const load = (messages: Message[]) => {
    turnCount = 0;

    const counted = recount(messages);

    // ollama has not seen this conversation, so the correction it gave for the
    // last one does not describe this one - drop back to a self-consistent
    // estimate and let the next turn measure it again
    tokens.measured = false;
    tokens.total = fixedCost() + tokens.messages;

    return counted;
  };

  // drop the conversation from the running totals, leaving the system prompt
  // and tool definitions - they are still sent on every turn
  const reset = () => {
    const freed = tokens.messages;

    recount([]);
    turnCount = 0;
    // as in load(): nothing measured describes an empty conversation, so the
    // total goes back to what the tokenizer says the fixed parts cost
    tokens.measured = false;
    tokens.total = fixedCost();

    return freed;
  };

  // the model changed under us - /model switched to another one. the prompt
  // names the model and the tokenizer belongs to it, so both are built again
  // and everything they measured is counted again from scratch
  const rebuild = (messages: Message[]) => {
    tokenizer = makeTokenizer();
    systemPrompt = buildSystemPrompt();

    // think() prepends the prompt to the array it returns, and the caller keeps
    // that array - so the old one is already in the conversation and would go
    // on naming the model that was replaced for the rest of the session
    if (messages[0]?.role === 'system') {
      if (systemPrompt) {
        messages[0] = { role: 'system', content: systemPrompt };
      } else {
        messages.shift();
      }
    }

    recount(messages);
    countFixed();
    // the count ollama gave described a prompt rendered by another model with
    // another template, so it says nothing about what this one will be sent
    tokens.measured = false;

    return tokens.total;
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
    rebuild,
    compact,
    recap,
    abort,
    tokens,
    get turnCount() {
      return turnCount;
    }
  };
};
