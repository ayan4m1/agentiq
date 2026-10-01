# Roadmap

<!-- agentiq: long-term memory. Leave the "## Todo" and "## Notes" headings in place. -->

## Todo

- [x] Give a session a recap so the user knows what a resumed or compacted session was doing. The `/recap [turns]` command has `thinker.recap()` (src/modules/ollama.ts) ask the model, with no tools, to recap the last `turns` (default `session.recapTurns`, AQ_RECAP_TURNS, 3; 0 covers them all) user <-> assistant turns chosen and rendered by src/modules/recap.ts.
- [x] Recover tool calls a model writes as text (JSON, `<tool_call>` tags or fenced blocks) when `tool_calls` is empty, and dispatch them through validation instead of ending the turn (src/modules/ollama.ts)
- [x] Add a non-interactive mode (`agentiq exec "<task>" --mode <mode>`) for scripts, CI and hooks, reusing approval modes and sessions (src/commands/exec.ts)
- [x] Make `/undo` roll back a whole turn, files and conversation together, instead of popping one write at a time while the history still claims the edits exist.
- [x] Integrate with the agent skills API and support reading skills from ~/.agentiq/skills.
- [x] Add `@file` mentions with tab completion, plus multi-line input: naming a file today still costs a `find`/`read` round or two on a (potentially) slow local model, the prompt is single-line so a stack trace cannot be pasted, and the `autoCompletion` option of inquirer-command-prompt is never passed, so even `/commands` do not complete. In src/modules/interactive.ts pass `autoCompletion` that completes `Command` names after `/` and project paths after `@` (from a cached listing that respects src/modules/ignore.ts, the same filter `find` and `list` use); in `addUserMessage`, expand each `@path` by appending the file's contents in the `read` tool's format (line numbers, truncation) so the model can `patch` from it directly.
- [x] Add a `/paste` command that opens `@inquirer/editor` (`typedPrompts` already drops multi-line entries from history) and passes the multi-line string to the model as a user message.
- [x] Run a project check (e.g. `tsc --noEmit` or lint) after each successful write/patch and append only newly introduced diagnostics to the tool result, with a short timeout, output capped by truncate() and a `/check on|off` toggle
- [x] When in planning mode, write plans to PLAN.md and offer a read_plan tool which allows the model to get the complete plan back if needed due to compaction later on.
- [ ] Add a staged review mode so a turn that touches many files asks once instead of once per write. checkpoints.ts already stacks every recorded change with its turn number, so a `/review` command (or a mode that switches manual into staged) can gather the changes a turn has made, render them as one combined diff by comparing each file's current content against the checkpoint blob it stored, and offer approve-all / reject / drill-into-one: on approve, replay the recorded writes in turn order through the normal checkpoint path; on reject, rewind() the turn as /undo does. Keep the per-change prompt as the default and make staged opt-in so a long task is not forced into bulk approval, and test that a staged pass shows every change in the turn and that rejecting rewinds them all
- [ ] Use this capybara as the mascot:

```text
           ,.
       _.-'  `------..__
     ,'  -              `-.
    (__,                   \
       `-.       ~zen~      |
          `-._   ____     ,'
              | |    |  | |
              |_|    |__|_|
```

- [x] Add a read-only `explore` tool that answers a codebase question in a separate, fresh-context sub-conversation (find/list/read/fetch/read_plan only, capped rounds and tokens) and returns just a concise report of paths, line ranges and key snippets, so orientation output never enters the main history. Implemented in src/modules/explore.ts (its own module, since tools cannot import the thinker without a cycle), reusing tool-call recovery, validation and interrupt handling. Print each sub-call indented with a `>` prefix under an "exploring…" status, and make it opt-out via `AQ_EXPLORE`. Test that it cannot dispatch write/patch/shell, that it stops at its round cap, and that only the report is appended to the main messages.
- [x] Add a `/rules` command to view and revoke "always" approvals, which `remember()` in src/modules/approval.ts saves to `~/.agentiq/approvals/<slug>.json` and `requestApproval()` honours from then on. `/rules` opens the saved rules in the custom picker (src/modules/picker.ts, now with a `browse` option where enter closes rather than chooses) to scroll through and remove with `r` then `y`, and just says so when there are none; `/rules add command|path <pattern>` saves one by hand, globs included. A rule's approval is announced with `✔ allowed by rule: <pattern>`.

## Notes

Do not stub out process.stdout.write in tests: some tests rely on the logs actually being printed.
