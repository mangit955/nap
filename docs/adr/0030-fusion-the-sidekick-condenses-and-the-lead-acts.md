# ADR-0030 — Fusion: the sidekick condenses, and the lead acts

**Status:** Accepted, 2026-11-07. Built and tested on `ScriptedLLMProvider` and the in-memory sandbox. No real model has run it, so it is unmeasured whether a cheaper sidekick's searches and summaries are good enough for the lead to act on, or how much it saves. Closes the "lead/sidekick pairing" item ADR-0020 deferred.

## Context

A turn runs on one model, the one the person picked. Some of what that model does is expensive and routine: reading twenty files to find where routes are declared, or summarising a long conversation so the turn can continue. Both cost the most tokens of anything a turn does, and both produce text that only the model itself reads. A cheaper model could do that work while the strong model does the rest.

`docs/research/` holds nothing on Devin's Fusion, so the design, wording and code here are Nap's own. Most of the machinery already existed: helpers with their own model and budget share (ADR-0020 D7), `NAP_SUBAGENT_MODEL` putting explore helpers on a cheaper model, `startTurn({ model, credentials })`, and a compaction path whose requests go through one function the agent owns.

## Decisions

### D1: The sidekick condenses; the lead does everything else

The **lead** is the turn's own model. The **sidekick** is a cheaper model named by the deployment. It does two jobs:

- **Explore helpers.** It searches and reads, and reports paths and line ranges.
- **API compaction summaries.** It condenses an older part of the conversation.

The lead does everything else: every step of the turn's own loop, edits, commands, `general` helpers, questions, plans, proposals and the final answer.

Both sidekick jobs have the same three properties, and the division is chosen for them:

1. **Lots of input, a little output.** This is where a turn's tokens go and where a cheaper price saves most.
2. **Only the lead reads the result.** A report or a summary is never kept in the project or shown to the person as the answer.
3. **The lead can recover what the result leaves out.** It can re-read the files a report names, and search the compaction history file a summary cites (ADR-0021). A weaker summary or report costs the lead extra reads, not a wrong result.

**Rejected:**

- **Sidekick `general` helpers and mechanical edits.** The sidekick's code would ship as if the person's chosen model wrote it, and checking it falls to the lead anyway. Edits that look mechanical often are not.
- **Condensing tool output automatically before the lead sees it.** It is lossy in a way the lead cannot undo: a foreground command's full output is gone unless the command runs again, and running a migration or an install again is not safe. The exact error line is usually what the lead needed. The log would also disagree with what the lead actually read.
- **Routing some of the loop's steps to the sidekick.** It would rewrite the lead's conversation and cached prefix mid-turn, and split one line of judgement between two models.
- **Offering helpers to Nap projects when Fusion is on.** ADR-0020's reasoning still holds: such a project is a few files already listed in the prompt. A cheaper helper is still a second loop paid to find what the lead can see.

### D2: A deployment setting, off by default

`NAP_SIDEKICK_MODEL` names the sidekick. Unset, Fusion is off and nothing changes. There is no per-turn switch: the person picks the lead, and the sidekick is a cost decision for whoever pays. Under D3 that is always the deployment. A per-turn choice would need a queue column, a migration, a route field, a composer control and a rollout order, all for a choice that would get the same answer every time.

At boot, the sidekick must be on `NAP_ALLOWED_MODELS`, checked the same way as `NAP_FALLBACK_MODEL` and `NAP_SUBAGENT_MODEL`. Setting both it and `NAP_SUBAGENT_MODEL` is refused: each would name what explore helpers run on, and refusing is clearer than having to remember which one wins. Existing deployments that set only `NAP_SUBAGENT_MODEL` behave exactly as before. That includes compaction, which stays on the lead.

### D3: Who pays — the sidekick exists only on the deployment's account

The sidekick is used for a request exactly when:

- `NAP_SIDEKICK_MODEL` is set,
- the turn has no `credentials` (the deployment is paying), and
- the sidekick is not the model the turn is on at that moment. That model can change if a refusal moves the turn to `NAP_FALLBACK_MODEL`.

A person's own key only ever goes to the model they picked. This is ADR-0020 D7's rule for helper models, applied to the whole pairing: on their key there is no sidekick at all. Explore helpers and summaries run on the turn's model, exactly as without Fusion. The rule is `Turn.#sidekick()` in `agent-service.ts`, and `fusion.test.ts` covers it.

### D4: Any sidekick failure is the lead's work, never the turn's failure

**A compaction summary** is one request. The flow:

1. The request takes its step and passes its budget checks exactly as before.
2. It goes to the sidekick only if the budget could also pay for the lead to repeat it: twice the request's estimated cost, plus the automatic reserve. So trying the sidekick can never leave the lead unable to write a summary it could have written before.
3. If the sidekick's window cannot hold the request, it goes straight to the lead. That is not counted as a failure.
4. The sidekick's answer must be what the compactor would accept: a complete message with text and no tool calls. A refusal, an error, a throw, a reply cut off at the limit, or no answer within two minutes all count as failures. On a failure, **the same request goes to the lead**, which is the path every summary took before Fusion. After one failure in a turn, the lead writes the rest of that turn's summaries. So a sidekick that is down costs one wasted request, or one two-minute wait, per turn, not one per chunk.
5. A cancelled turn is not a failed sidekick. It throws, as the lead's own request does, and nothing is sent to the lead.

The fallback is per request and lives entirely in the agent's `complete` function. The runtime's compactor, the history file and the compaction events do not change. Native compaction is the provider's own session operation, so Fusion does not touch it.

**An explore helper** that fails behaves as every helper always has. The lead gets a failed tool result that says why, and does the search with its own read and search tools. The helper's budget share, step limit and cancellation do not change.

**Cancellation, steering, plan mode and helpers behave as before.** Fusion adds no hook, takes no steers, offers and declares no new tools, and narrows nothing. A plan mode turn's explore helpers run on the sidekick and are still read-only.

**Rejected:** retrying a failed helper on the lead model. The lead already has every tool the helper had, and can decide whether to search at all. A retry would be a third loop paying lead prices for work the lead may not need.

### D5: Every sidekick token is the turn's

- The sidekick's usage goes to the turn's `TurnBudget`. The ceiling does not move, so a turn whose sidekick overspends fails on the budget as any other turn would.
- A summary counts one step whichever model writes it, so step ceilings do not move either.
- `turn.completed.usage` includes the sidekick's tokens, both for helpers (as before) and for summaries. The sidekick's model conversation is in the same list the fallback model's is.
- `compaction.completed.usage` includes a failed attempt as well as the lead's repeat.
- A request abandoned before its usage arrived, by timeout or by a throw, marks the turn's usage incomplete (`usageIncomplete`), as a helper stopped mid-call already did.

`TurnBudget` counts tokens, not money, so a sidekick token weighs the same as a lead token against the ceiling. That is deliberate: the ceiling bounds work, and the saving is in price, not in tokens.

### D6: No event-contract change

No new event type and no new field. A sidekick's helper looks like any helper in the pane and the log, and a summary looks like any summary. An additive field would still reach old browser tabs and old API processes, which parse payloads strictly and would reject it (ADR-0025's rollout note). That would be a new problem for users, caused by an option that is off by default.

The cost of this choice is that the log does not say which model answered. NapBench prices every token at the turn's requested model, so **a Fusion run's cost estimate overstates what it cost** (`packages/bench/src/pricing.ts`). It also cannot count how often the sidekick fell back.

### D7: The lead's cache is untouched

The lead's tool block, system prompt and conversation are byte-identical with Fusion on and off. `fusion.test.ts` asserts this on the first request. Sidekick requests are separate conversations. A compaction summary request already had its own system prompt and no tools, so it never read the lead's cached prefix. Moving it to the sidekick gives up no cache read (ADR-0024).

## Consequences

- `NAP_SIDEKICK_MODEL` is new and optional. `NapAgentService` takes `sidekickModel` and `sidekickTimeoutMs`. `compose.ts` passes the setting through.
- On a Nap project, Fusion changes only who writes compaction summaries. Helpers are still offered only to imported repositories, so that is the only place it changes who searches.
- A person sees no difference in the pane. What they could notice is the quality of the lead's work after a compaction, or after a sidekick search, if the sidekick is weak. That is what a funded run has to measure.
- Mutation-checked: each guard below was broken on purpose and the suite caught it: the own-key rule, the same-model rule, fallback on bad output, fallback on a throw, the deadline, no fallback for a cancelled turn, budget recording, usage reporting, the breaker after a bad answer and after a timeout, room for the lead's repeat, step counting, the window check, explore-only routing, failed-attempt usage, the allowlist check and the both-set check. The first runs missed two of them. That is now in `docs/GOTCHAS.md` (Testing).

## Unverified, and what a funded run needs

Only real models can settle these:

- **Whether a cheaper sidekick's summaries keep the lead on track.** That means comparing lead-alone with Fusion on turns long enough to compact. NapBench's current tasks are short Nap projects that rarely compact and are never offered helpers. A comparison on them would measure nothing, so the run first needs a task that forces compaction (a low `NAP_CONTEXT_BUDGET_TOKENS`, or a long multi-step task) and ideally an imported-repository task where helpers are offered.
- **Whether it saves money, and how much.** Before spending, the run needs a per-model split of a turn's usage, either as an additive event field rolled out in ADR-0025's order or read from the provider's per-generation cost. Without one, the Fusion arm is priced as if every token were the lead's.
- **How often the sidekick fails and the lead repeats the work.** This is not visible in the log (D6). The same split would show it.
- **Whether two minutes is the right deadline for a real sidekick's summary.**

**Priced first, as earlier runs were.** At the 2026-08-17 table, a terra-led run on the current tasks cost about $0.02 (`docs/napbench-verification-measurement.md`). Lead `openai/gpt-5.6-terra` against lead terra with sidekick `openai/gpt-5.6-luna`, with three runs per arm on four compaction-forcing tasks, is 24 runs. Compaction-forcing runs are longer, so allow three to five times the cost per run: **roughly $1.50–$2.50**. With `anthropic/claude-opus-5` as the lead, where the price gap that makes Fusion worth having is widest, multiply by about five: **roughly $8–$12**. Neither should be spent until the usage split exists, because without it the result cannot be priced.
