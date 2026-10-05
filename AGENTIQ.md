# agentiq

A local-first coding agent that runs as an interactive REPL against an Ollama
server, the Anthropic API, or any OpenAI-compatible server. This file is a project overlay: it is appended to agentiq's built-in
system prompt, so it holds what is specific to _this_ codebase rather than
general instructions about how to be an agent.

## Layout

- `src/index.ts` - the commander entry point. Each subcommand in
  `src/commands/` runs as its own executable and parses its own options.
- `src/commands/run.ts` - `agentiq run`, a thin wrapper around `startRepl()`.
- `src/commands/exec.ts` - `agentiq exec <prompt>`, a single headless turn
  with no one at the terminal to answer questions.
- `src/modules/startup.ts` - `startAgent()`, the setup both commands share:
  preflight, model selection, tokenizer, and the thinker.
- `src/modules/interactive.ts` - `startRepl()`, the interactive prompt itself.
- `src/modules/repl.ts` - `createController()`, the testable core of the run
  loop: slash commands, compaction triggers, `/undo`, and the loop that keeps
  taking turns while the model is still calling tools.
- `src/modules/thinker.ts` - `makeThinker()`, which owns the streaming chat
  call, tool dispatch, and token accounting. `compaction.ts` holds the logic
  for choosing what to elide; the shared client is `chatProvider` from
  `src/providers/index.ts`.
- `src/modules/mcp.ts` - connects to the MCP servers in `config.yml` at
  startup and wraps each of their tools as a `ToolCall` named
  `mcp__<server>__<tool>`, which `setMcpTools()` in `src/tools/index.ts`
  puts in the registry before the thinker is made. `/mcp` (`pickServers` in
  `picker.ts`) turns servers on and off and retries failed ones, after which
  the registry is replaced and the thinker rebuilt. Their arguments skip
  `validateArgs()`'s filtering, since they never went through `makeParameter()`.
- `src/modules/tools.ts` - argument validation and recovery of tool calls the
  model wrote as text instead of emitting properly.
- `src/modules/models.ts` - the model/tokenizer pairs in `~/.agentiq/models.yml`,
  kept per provider, and the prompting `/model` does to add or switch between them (`picker.ts`).
- `src/modules/plan.ts` - the plan `present_plan` saves and `read_plan`
  returns, kept in `~/.agentiq/plans/<project slug>.md`. It is written before
  the user approves anything, so it must never land in the project directory.
- `src/modules/turn.ts` - per-turn flags: whether anyone is at the terminal,
  and whether a tool has already handed control back to the user.
- `src/modules/` - otherwise one concern per file: approval modes, checkpoints,
  config, session persistence, background jobs, tokenizer caching, preflight,
  the roadmap, skills from `~/.agentiq/skills` (only enabled ones reach the
  prompt; `/skills` toggles them via `picker.ts`), saved prompts from
  `~/.agentiq/commands` and `.agentiq/commands` that `runCommand()` sends as
  `/<name>` (`commands.ts`), the system prompt.
- `src/tools/` - one tool per file, each exporting a `definition` built with
  `makeTool()` and a `handler`. `src/tools/index.ts` is the registry, and
  leaves out the tools config has not enabled - the roadmap tools, `explore`,
  and `decide`, which is only offered with ollama and a `decide.model`.
- `src/providers/` - one `ChatProvider` per backend: `ollama.ts`,
  `anthropic.ts`, and `openai.ts` (any Chat Completions server - vLLM,
  llama.cpp, or the OpenAI API). A capability only one backend has is an
  optional method on the interface - `countTokens?` for anthropic, `decide?`
  (ollama's System One) for ollama. openai has neither, and like anthropic is
  never paired with a tokenizer (`usesHfTokenizer()` in `tokenizer.ts`).
- `src/utils/index.ts` - shared helpers, including the content budget used to
  keep tool output from overflowing the context window.

## Conventions

- TypeScript, ESM, Node 22+. Built with rollup, formatted with prettier
  (single quotes, no trailing commas), linted with eslint.
- Arrow functions and named exports throughout. No default exports.
- Comments explain _why_, not what. The codebase is dense with notes about
  non-obvious platform behaviour - preserve that when you change the code
  around them, and add one when you do something that will look wrong later.

## Adding a tool

If it is appropriate to add a new tool, follow this process each time to get it right.

1. Create `src/tools/<name>.ts` exporting `definition` and `handler`.
2. Declare parameters with `makeParameter()` - this is what registers them for
   runtime validation in `src/modules/tools.ts`, so a tool that skips it
   gets no argument checking.
3. Register it in the `tools` array in `src/tools/index.ts`.
4. If it changes anything on disk or runs a command, call `refusePlanning()`
   first and then `requestApproval()`, and return `describeDenial()` when the
   answer is no. Read-only tools do neither.
5. Pass a subject to `requestApproval()` - `{ kind: 'command' | 'path', value }`
   - so that "always" can be remembered by `src/modules/approval.ts`.
6. State the tool keeps for itself (like the plan) belongs under `home` from
   `src/modules/config.ts`, never in the project - writing there without
   approval is exactly what step 4 exists to prevent.
7. If it writes to a file, call `record()` from `src/modules/checkpoints.ts`
   immediately before the write, so `/undo` can roll back the turn that made it.

## Working here

- `yarn build` compiles, `yarn lint` checks, `yarn test` runs the suite.
- Tests sit beside what they cover as `*.test.ts` and run on `node --test`
  against the sources, with no build step. Node erases types rather than
  compiling them, so the code must stay erasable: no enums (use an `as const`
  object plus a derived union, as `src/types/index.ts` does) and `import type`
  for anything used only as a type. `test/hooks.mjs` supplies a simulant of
  rollup's module resolver.
- Tool output is capped against the context window - see `getContentBudget()`
  and `truncate()` in `src/utils/index.ts`. A new tool that returns file or
  command output should use them.
- Do not commit unless asked.
