# Roadmap

<!-- agentiq: long-term memory. Leave the "## Todo" and "## Notes" headings in place. -->

## Todo

- [ ] Run a project check (e.g. `tsc --noEmit` or lint) after each successful write/patch and append only newly introduced diagnostics to the tool result, with a short timeout, output capped by truncate() and a `/check on|off` toggle
- [x] Recover tool calls a model writes as text (JSON, `<tool_call>` tags or fenced blocks) when `tool_calls` is empty, and dispatch them through validation instead of ending the turn (src/modules/ollama.ts)
- [x] Add a non-interactive mode (`agentiq exec "<task>" --mode <mode>`) for scripts, CI and hooks, reusing approval modes and sessions (src/commands/exec.ts)
- [ ] Add a `/rewind` command that rolls back a whole turn, files and conversation together: `/undo` (src/modules/checkpoints.ts) pops one write at a time and leaves the history claiming the edits still exist, so `/clear` is the only reliable recovery when a model goes off track over several edits. Tag each `Checkpoint` with the index of the user message whose turn made it (a counter advanced by `addUserMessage` in src/modules/repl.ts); `/rewind` shows a `select` of earlier prompts (reuse the `typedPrompts` filter in src/modules/repl.ts), undoes every checkpoint at or after the chosen turn newest first using the existing `undo()` logic, truncates `nextThought.messages` to just before that prompt, calls `thinker.load()` and `rewrite()` from src/modules/session.ts, and prefills the input with the old prompt so it can be edited and resent. It does not reverse side effects of `shell` commands, and its confirmation says so. Test by making 3 writes across 2 turns, rewinding to turn 1 and checking that the files and the message count are both back to their earlier state
- [ ] Add `@file` mentions with tab completion, plus multi-line input: naming a file today still costs a `find`/`read` round or two on a slow local model, the prompt is single-line so a stack trace cannot be pasted, and the `autoCompletion` option of inquirer-command-prompt is never passed, so even `/commands` do not complete. In src/modules/interactive.ts pass `autoCompletion` that completes `Command` names after `/` and project paths after `@` (from a cached listing that respects src/modules/ignore.ts, the same filter `find` and `list` use); in `addUserMessage`, expand each `@path` by appending the file's contents in the `read` tool's format (line numbers, truncation) so the model can `patch` from it directly; support multi-line input with a trailing `\` continuation or a `/paste` command that opens `@inquirer/editor` (`typedPrompts` already drops multi-line entries from history). Test that `@src/index.ts` expands to its line-numbered content and that ignored paths are never offered for completion
- [ ] Integrate with the agent skills API and support reading skills from ~/.agentiq/skills.

## Notes

Do not stub out process.stdout.write in tests: some tests rely on the logs actually being printed.
