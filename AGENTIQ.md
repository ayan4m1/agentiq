# agentiq

A local-first coding agent that runs as an interactive REPL against an Ollama
server. This file is a project overlay: it is appended to agentiq's built-in
system prompt, so it holds what is specific to _this_ codebase rather than
general instructions about how to be an agent.

## Layout

- `src/commands/run.ts` - the REPL itself: the prompt, the slash commands, and
  the loop that keeps taking turns while the model is still calling tools.
- `src/modules/ollama.ts` - `makeThinker()`, which owns the streaming chat call,
  tool dispatch, token accounting, and compaction.
- `src/modules/models.ts` - the model/tokenizer pairs in `~/.agentiq/models.json`,
  and the prompting `/model` does to add or switch between them.
- `src/modules/` - one concern per file: approval modes, session persistence,
  background jobs, tokenizer caching, argument validation, the system prompt.
- `src/tools/` - one tool per file, each exporting a `definition` built with
  `makeTool()` and a `handler`. `src/tools/index.ts` is the registry.
- `src/utils/index.ts` - shared helpers, including the content budget used to
  keep tool output from overflowing the context window.

## Conventions

- TypeScript, ESM, Node 22+. Built with rollup, formatted with prettier
  (single quotes, no trailing commas), linted with eslint.
- Arrow functions and named exports throughout. No default exports.
- Comments explain _why_, not what. The codebase is dense with notes about
  non-obvious platform behaviour - preserve that when you change the code
  around them, and add one when you do something that will look wrong later.
- Conventional commits (`feat:`, `fix:`, `chore:`, `refactor:`). commitlint
  enforces this via husky.

## Adding a tool

1. Create `src/tools/<name>.ts` exporting `definition` and `handler`.
2. Declare parameters with `makeParameter()` - this is what registers them for
   runtime validation in `src/modules/validate.ts`, so a tool that skips it
   gets no argument checking.
3. Register it in the `tools` array in `src/tools/index.ts`.
4. If it changes anything on disk or runs a command, call `refusePlanning()`
   first and then `requestApproval()`, and return `describeDenial()` when the
   answer is no. Read-only tools do neither.
5. Pass a subject to `requestApproval()` - `{ kind: 'command' | 'path', value }`
   - so that "always" can be remembered in `src/modules/rules.ts`.
6. If it writes to a file, call `record()` from `src/modules/checkpoints.ts`
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
