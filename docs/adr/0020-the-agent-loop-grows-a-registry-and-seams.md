# ADR-0020 — The agent loop grows a tool registry and seams

**Status:** Accepted, 2026-10-27. Built and tested on fakes and real local shells (macOS and Debian). No real model or real E2B sandbox has run any of it yet, so what it does for agent quality is unmeasured. A funded NapBench comparison is the next step and needs its own approval.

## Context

The agent had seven tools named in a closed list, one loop that ran every tool call one after another, and no way to recover from anything the provider had not already retried. Research into Devin's harness ([primary sources](../research/devin-browser-primary-sources.md)) showed what a stronger loop adds. Tools are declared and selected per turn. Reads run in parallel. Shells outlive one call. Edits come in the format each model family was trained on. The person can see a plan and answer a question. Searches run in a helper so their output never fills the parent's context. And the loop has points where behaviour attaches without the loop itself changing.

Much of Devin's harness exists because it runs on a person's machine: an OS sandbox, permission prompts, a safety model judging commands, a terminal UI, plugins. Nap's agent runs in an E2B VM with nobody approving each step, so none of that is copied. Neither is MCP, which brings credential handling this project has not designed. The mechanisms are rebuilt in Nap's own code and words.

## Decisions

### D1: The closed name list stays; a registry decides what each turn is offered

`TOOL_NAMES` in `@nap/shared/events` is still the only set of names `tool.call` accepts. It is only ever added to, so old sessions keep parsing. Sixteen names now: the seven before, plus `apply_patch`, `glob`, `shell_output`, `shell_input`, `shell_kill`, `todo_write`, `ask_user`, `run_subagent` and `read_subagent`.

`packages/agent/src/tools/definitions.ts` declares every tool's schema and description. `execute.ts` maps each name to its handler through a mapped type, so a tool without a handler fails typecheck and dispatch needs no cast. `toolset.ts` decides which tools a turn is offered, as a pure function of facts about the turn:

- **Who asked.** An app test may only look. A repair turn has nobody to answer a question.
- **What is wired.** The computer needs a desktop and an image model. Helpers need prompts from the context engine.
- **Model family.** GPT models are also offered `apply_patch`; Claude models are not handed a second way to edit.
- **Helpers.** A helper never gets the tools that talk to the person or start more helpers.

A real tool that a turn was not offered is still logged as a call, then refused. An app test that tries to write a file is evidence about that test. A name that is no tool at all is never logged.

`@nap/shared/tool-kinds` gives every name a kind (read, edit, search, execute, plan, ask, delegate, computer). The pane groups the work log by kind, so a new tool is summarised without the web learning its name.

We considered aliasing names per family, e.g. Codex's `update_plan` for GPT and `todo_write` for Claude. Two names for one tool doubles the contract and the transcript's vocabulary for no measured gain. Families differ in what they are offered, not in what anything is called.

### D2: Four seams, each with a user today

`TurnHook` (`packages/agent/src/hooks/hook.ts`) has four optional methods:

- `beforeModel`: a reminder appended to the last user message.
- `afterTool`: may add words to a result; may not change whether it failed, or its images.
- `beforeStop`: may give a reason not to end yet. The loop asks at most twice per turn, so no hook can keep a turn alive.
- `compacted`: anything a hook added is gone, so it can add it again.

The users are the project-rules hook, plan tracking, and the uncollected-helpers check. We did not adopt Devin's full effect system. The seams give the same extension points without rewriting the loop's invariants: one terminal event, all results returned in one message, and nothing persisted by the agent.

### D3: Reads run together, the log reads as if they had not

Consecutive calls that change nothing run at once: reads, listings, globs, searches, and foreground `explore` helpers. Everything else runs alone, in order. A concurrent group's events are held and written in call order once the group finishes. The log is therefore byte-for-byte what serial execution would have written, and no consumer has to untangle two calls at once. The cost: a concurrent group's events appear when the group ends rather than as each call ends.

### D4: A shell's state lives in the sandbox

`run_command` with `background` starts the command in its own session. Its output, exit code, process group and read position are files under `/tmp/nap-shells/<id>/`. Every later call is one plain `exec`. So a shell outlives the turn and the worker that started it, and `SandboxManager` needed only an optional `timeoutMs` on `exec`. That is how a foreground command can wait longer than E2B's one-minute default. The model's command is written to a file, never spliced into a script. Input typed into a shell answers to the same command guard as `run_command`.

Verified against real `bash` on macOS (where `/bin/sh` is bash and there is no `setsid`) and on Debian (dash and `setsid`, as on E2B). The Debian run found that dash rejects `kill -- -PID`, which had left a stopped shell's children running. Not yet run on a real E2B sandbox.

### D5: A file is read before it changes

A per-turn ledger records what the turn has read or written. `edit_file` and `write_file` refuse to change an existing file the turn has not seen. The refusal costs one read; the error it prevents is a confident edit against text that is not there, or a whole file overwritten unseen. `apply_patch` is exempt: its context lines are its own check. Reads return numbered lines and take an offset and limit.

### D6: Plans and questions are events; a question ends the turn

`todo_write` emits `plan.updated` with the validated list. `ask_user` emits `agent.question` and ends the turn once its batch is answered. The answer is the person's next message, which is what any answer in a chat already is, so there is no new state. The event schemas and the tool schemas are the same objects in `@nap/shared/agent-plan`. Plan tracking nudges once if the plan goes stale, and once if the turn tries to end with items open.

### D7: Helpers are a smaller loop inside the turn, offered to imported repositories

`run_subagent` runs a second model loop with its own conversation and a narrower tool set, and returns its final report. Four rules keep it accountable:

- **It spends the turn's budget.** Every token is recorded against the parent's `TurnBudget`, and one helper may use at most half of what remains.
- **It lives inside the turn.** It shares the turn's cancellation. A background helper nobody collected is stopped before the turn commits.
- **Its traffic stays out of the log.** Its tool calls would replay into the parent's conversation as calls the parent never made. The log gets `subagent.started`, the files it changed, and `subagent.completed`.
- **On a person's own key it uses the turn's model.** A cheaper helper model (`NAP_SUBAGENT_MODEL`) is the deployment's to choose and to pay for.

The context engine offers helpers only to imported repositories. A Nap project is a handful of files already listed in the prompt, where a helper is a second model paid to find what the first can see. The plan's separate `code_search` tool became the `explore` profile: two tools for one job would only make the model choose between them.

### D8: Recovery the provider cannot do

- **A retryable failure gets one more attempt after a longer wait.** The provider's own retries are already spent and are sized for a dropped connection, not a throttled minute. The wait is announced and cancellable.
- **A refusal can continue on `NAP_FALLBACK_MODEL`.** Once per turn, only on the deployment's account, announced as a `system.notice`, and billed with the model it replaced.
- **A reply cut off at the output limit gets asked for the rest**, at most twice.
- **Malformed arguments** were already an error result, never a failed turn.

### D9: Project rules arrive with the first result in their directory

`AGENTS.md` and `CLAUDE.md` from the touched file's directory and every directory above it are appended to the first result that touches them, read through the port in parallel. The root's file is included only for imported repositories, because a Nap project's root brief is already in the system prompt.

## Consequences

- `CLAUDE.md`'s description of the tool set, `README.md` and the `/docs` sandbox section say what is offered, not a fixed count.
- Every exhaustive consumer of the event union handles four more types: the turn log, the harness printer, the transcript and its treatment tables, and the db round-trip fixtures.
- Nothing here has met a real model. The descriptions, the reminder wording and the stop nudges are all untuned prose, and whether helpers, plans or parallel reads improve outcomes is a NapBench question. Phase 6 of the plan prices that run before spending.
- Deferred: plan mode, steering a running turn, skills, the lead/sidekick pairing, and compaction's history file. Each is a separate decision.
