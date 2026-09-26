# Roadmap

<!-- agentiq: long-term memory. Leave the "## Todo" and "## Notes" headings in place. -->

## Todo

- [ ] Run a project check (e.g. `tsc --noEmit` or lint) after each successful write/patch and append only newly introduced diagnostics to the tool result, with a short timeout, output capped by truncate() and a `/check on|off` toggle
- [x] Recover tool calls a model writes as text (JSON, `<tool_call>` tags or fenced blocks) when `tool_calls` is empty, and dispatch them through validation instead of ending the turn (src/modules/ollama.ts)
- [x] Add a non-interactive mode (`agentiq exec "<task>" --mode <mode>`) for scripts, CI and hooks, reusing approval modes and sessions (src/commands/exec.ts)
- [x] Make `/undo` roll back a whole turn, files and conversation together, instead of popping one write at a time while the history still claims the edits exist. Each `Checkpoint` is tagged with a monotonic turn number from `beginTurn()` (src/modules/checkpoints.ts), which `addUserMessage` in src/modules/repl.ts calls; `/undo` offers a `select` of earlier prompts, confirms (noting `shell` side effects are not reversed), `rewind()`s every checkpoint from that turn on newest first, truncates the conversation to just before the prompt, calls `thinker.load()` and `rewrite()`, and prefills the input with the old prompt
- [ ] Add `@file` mentions with tab completion, plus multi-line input: naming a file today still costs a `find`/`read` round or two on a slow local model, the prompt is single-line so a stack trace cannot be pasted, and the `autoCompletion` option of inquirer-command-prompt is never passed, so even `/commands` do not complete. In src/modules/interactive.ts pass `autoCompletion` that completes `Command` names after `/` and project paths after `@` (from a cached listing that respects src/modules/ignore.ts, the same filter `find` and `list` use); in `addUserMessage`, expand each `@path` by appending the file's contents in the `read` tool's format (line numbers, truncation) so the model can `patch` from it directly; support multi-line input with a trailing `\` continuation or a `/paste` command that opens `@inquirer/editor` (`typedPrompts` already drops multi-line entries from history). Test that `@src/index.ts` expands to its line-numbered content and that ignored paths are never offered for completion
- [x] Integrate with the agent skills API and support reading skills from ~/.agentiq/skills.

## Notes

Do not stub out process.stdout.write in tests: some tests rely on the logs actually being printed.
