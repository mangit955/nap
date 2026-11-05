# ADR-0025 — Plan mode proposes, and the next message decides

**Status:** Accepted, 2026-11-03. Built and tested on fakes, the in-memory sandbox and a real Postgres. No real model or E2B sandbox has run it, so whether models plan well under these prompts is unmeasured. Closes the "plan mode" item ADR-0020 deferred.

## Context

Every turn went straight from a prompt to edits. For a large change, the person had no chance to see, correct or reject the approach before code was written and committed. Devin's local harness has a plan the person approves before execution, and that was the feature reference. The design, wording and code here are Nap's own.

Three things already existed to build on. ADR-0020's registry chooses a turn's tools from facts about the turn. `ask_user` shows a turn can end waiting on the person, with no new state, because the answer is the next message. ADR-0008 makes the event log the source of truth, so a card's state has to be a fold over it rather than a flag somewhere.

## Decisions

### D1: Plan mode travels with the prompt

The plan intent is a per-turn choice made by whoever sends the prompt, so it travels with the prompt, like the model, and is never a deployment setting. One tagged union, `PlanIntent` in `@nap/shared/agent-plan`, carries it everywhere:

- `{ intent: "propose" }` runs the turn in plan mode.
- `{ intent: "approve", planTurnId }` approves the plan that turn proposed, and runs an ordinary turn that carries it out.

It is validated by Zod in the turn route's body. It rides the queued request in a nullable `turn_requests.plan` jsonb column (migration 0017), parsed on the way out as attachments are, and is written onto the `user.message`, so the log says what each prompt asked for. Runtime gives `mode: "plan"` to the context engine and the agent. Turns go through HTTP, and the WebSocket carries only events, so the route is the boundary.

### D2: Read-only is enforced where calls run, not just in the tool list

`toolset.ts` offers a plan mode turn `read_file`, `list_files`, `glob`, `search_files`, `shell_output`, `ask_user`, `run_subagent`, `read_subagent` and `propose_plan`. It does not offer any edit tool, `shell_input` or `shell_kill`, `todo_write` (the proposal *is* the deliverable), or the computer (clicks change the running app). Leaving a tool out of the list is not the guarantee. The guarantee is that `ToolContext.planning` narrows what *runs*:

- A tool the turn was not offered is logged as a call and refused in plan mode's own words (ADR-0020 D1's rule).
- `run_command` is omitted and refused at execution, including foreground reads. A command-name allowlist cannot establish read-only behavior: environment variables, executable paths and repository configuration can make readers run arbitrary programs. Review reproduced writes through `GIT_EXTERNAL_DIFF` and `git grep --open-files-in-pager`. File reads and searches provide the investigation tools without accepting model-authored shell commands.
- `run_subagent` may only start `explore` helpers.
- `propose_plan` is refused outside plan mode. A turn that ends on it skips its commit, and an ordinary turn that did work must never skip its commit.

We dropped `run_command` rather than expanding its allowlist. This sacrifices shell access to history tools such as `git log` and `git blame` during planning. A planner can inspect source through the dedicated read and search tools, and state any history-dependent uncertainty in the proposal. A future history-inspection tool would need fixed arguments and control over Git's executable hooks and configuration.

### D3: A proposal is an event, and the turn ends awaiting approval

`propose_plan` takes `{ title, plan }`, with the title capped at 120 characters and a Markdown body capped at 12,000. It emits `plan.proposed`, whose payload uses the same schema the tool validates against. It returns `endsTurn` and `awaits: "plan_approval"`, so the batch is answered and the turn ends, as `ask_user` already does. The agent then skips `finalize` and writes `turn.completed` with `commitSha: null` and `awaiting: "plan_approval"`. That optional field is the distinct outcome, and old rows parse without it.

A plan mode turn that tries to stop without proposing gets one `beforeStop` reminder from a `PlanMode` hook. It gets one, not two, because "nothing needs changing" is sometimes the honest answer.

### D4: A plan mode turn opens no job

Before this change, a turn that changed nothing still opened a job, ran `git commit` (which found nothing), closed the job `unverified`, and called the repository job's finish hook. For a plan, even that is too much. Runtime handles a `propose` turn the way it handles a manual compaction: user message, sandbox, `#attempt` with no `finalize`, then return. So there is no `job.started`, no commit, no verification, no snapshot, no photograph, and no open job for the next open to continue. The runtime passes no `finalize`, and the agent skips the commit of a turn that ended on a proposal. Both are needed, because a plan mode turn that stops without proposing must not commit either.

### D5: The next message decides; one fold says so

What became of a plan is not stored. `planStates` in `@nap/shared/plan-mode` folds the log:

| What happened | Status |
|---|---|
| `plan.proposed`, turn still running | `drafting` |
| turn completed, nothing said since | `awaiting`, the only approvable state |
| turn failed | `interrupted` |
| next non-repair `user.message` approves this turn's plan | `approved` |
| the turn that approved it fails, with no newer request | `awaiting` again |
| next message is another `propose` | `revised` |
| next message is anything else | `superseded` |

A turn that proposes twice keeps the last proposal. Repair prompts settle nothing, because they are the verifier speaking. Two rules keep the fold agreeing with what the runtime did. An approval of a plan that is not `awaiting` settles nothing, because the runtime refuses it under the lease and builds nothing; counting it as an answer would let a stale tab set aside the newer plan the person is looking at. An approving turn that fails puts its plan back to `awaiting` unless a newer request has replaced it. Approving again is then the recovery, and the failed turn's retry is exactly that. Verification and snapshots run after `turn.completed`, so a failure in those later stages does not reopen the plan. A process lost after Git commits but before the completion event becomes durable can leave committed work without that event; this existing recovery gap is not proof that a failed turn changed nothing. Only the approving turn itself restores the plan: a repair turn of the job it opened has its own id, and the plan stays approved when one fails.

Two consumers share this fold, and that is why it is one function. The chat pane draws the card from it, so replaying a session draws a settled card as settled. The server refuses stale approvals with it twice. At admission it returns a 409 when the plan is not awaiting, or when any request is still queued for the session (that request would run first and settle the plan). Under the lease, `pendingPlan` checks again against the history read before the prompt was logged, because only there has the log stopped moving. If two tabs both approve, one builds and the other gets `turn.failed` with a sentence saying why. The reason is `internal`, which is not quite right. A new failure reason would change every exhaustive consumer to cover a race that admission already makes narrow.

### D6: The approved plan rides in the context of the whole job

An approval opens a job whose objective is the plan's title, so "Approved" never names a job. Its commit subject is the title too. `JobContext.plan` carries the plan into the context engine, which renders `<approved_plan>` after the job brief in the turn context on every turn of the job, repair turns included, and never cuts it to fit. Like the job brief, the approved plan rides in the current user message rather than the system prompt, preserving ADR-0024's stable cached prefix. The proposal's own `tool_use` is also in the history, but staleness and compaction may trim that copy. A job a restart continues finds its plan again with `approvedPlanOfJob`, read from the log: the job opens in the same turn as the approving prompt, and that prompt names the proposing turn. Nothing new is written.

`PLAN_MODE_PROMPT` comes after the workspace instructions in a plan mode turn's system prompt. It is stable across planning turns. Switching between planning and building changes the tool declarations and this system suffix, so those turns cannot share the entire cached prefix. File listings, memories and approved plans remain in turn context as ADR-0024 requires. The prompt explicitly overrides the contract's "finish the whole task", so a model told to build does not have to work out why every edit fails.

### D7: The card, the composer, and retries

`ProposedPlanCard` renders the title and Markdown body. While the plan is `awaiting` and nothing is running, it offers **Approve plan** and **Request changes**. Request changes opens a text box whose words go out as the next `propose` message. Typing anything else in the composer moves on, and the card settles as set aside. Approving sends "Approved. Build this plan." with the approve intent, through the same submission path as the composer. It gets the same optimistic message, rate limit and refusal wording. The composer's **Plan mode** switch stays on across sends, because replying to a plan is asking for another plan, and a switch that reset itself would quietly turn the second reply into a build. A failed turn's retry carries its prompt's plan intent, so retrying a plan mode turn never builds something nobody approved. A retry that would approve a plan no longer `awaiting` is not offered, because the server could only refuse it. A question a plan mode turn asked is answered in plan mode too: clicking an option sends it with the propose intent, as typing it with the switch on would, so an answer never starts a build. The card's buttons, and a question's, are disabled while a message is still on its way and the log does not hold it yet, so a double click cannot send two approvals. `/compact` is always sent without the plan intent, whatever the switch says.

## Consequences

- One new tool name (`propose_plan`, appended to `TOOL_NAMES`, kind `plan`), one new event type, and two optional payload fields (`user.message.plan`, `turn.completed.awaiting`). Every exhaustive consumer handles them: the turn log (shape only, never the plan's text), the harness printer, the transcript and its treatment tables, and the db round-trip fixtures.
- **Rollout order matters, as it did in ADR-0017.** Old readers parse events strictly, so an old browser tab or an old API process would reject `plan.proposed` and the new optional fields. An old worker is the other risk: it claims a request without reading `plan`, so it would run a plan mode request as a build with every tool. So: migrate first, then stop and drain the old workers and deploy new ones, then the API and reaper, then the web. New workers write the new shapes only when handed a plan intent, and only the new API admits one. `docs/DEPLOY.md` has the steps. The Render release script enforces this order: it preflights
  the worker's configured migration command, deploys the worker and waits for `live`, then deploys
  the API, reaper and web. The worker runs migrations before booting; the API keeps an idempotent
  repeat for manual deploys. Render's service setting must be configured before merge because
  triggering a deploy does not apply `render.yaml`. A missing setting fails before any deploy.
  Render's documented shutdown-before-deploy-completion sequence is the hosted lifecycle
  dependency; free tests cover release ordering and fail-closed configuration, not real shutdown.
- `bun run harness --plan "<prompt>"` runs a plan mode turn on fakes. `--plan --approve` also approves the plan and runs the turn that builds it.
- Not here: plan mode for a project's very first prompt (the dashboard composer), editing a plan in place before approving, and a funded comparison of whether planning first improves outcomes. Whether a real model follows `PLAN_MODE_PROMPT`, keeps plans proportionate and uses the available read tools effectively can only be measured with a real model.
