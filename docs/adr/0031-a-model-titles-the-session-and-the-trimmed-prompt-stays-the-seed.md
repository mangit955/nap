# ADR-0031 — A model titles the session, and the trimmed prompt stays the seed

**Status:** Accepted, 2026-11-09. Built and tested on `ScriptedLLMProvider` and a real Postgres. No real model has been asked for a title. The cost below is worked out from list prices, not measured, and the titles are untested.

## Context

`packages/shared/src/project-title.ts` names a project from its first prompt by trimming words, and says on purpose that it is not a model call: a name is a convenience, and paying for a round trip and adding a failure path to creating a project was a bad trade. The result is often fine. It is also often a fragment of a sentence ("Habit Tracker" when the prompt said "build me a habit tracker", but "I'm Trying to Get My Team" when it said "I'm trying to get my team to stop missing standups").

T3 Code titles a thread with a model and lets the person regenerate the title (`packages/provider-core/src/server/textGenerationPrompts.ts`, MIT, read at `pingdotgg/t3code@5127302`). Map #127 decided that Nap does the same, paid for by whoever paid for the turn.

## Decisions

### D1: The trimmed title stays as the instant seed

Creating a project still writes `titleFromPrompt(prompt)` in the same statement as before. The model's title replaces it later, if it arrives and passes the checks in D5. Nothing about creating a project waits on a model or can fail because of one: no credentials, a refusal, a timeout or nonsense output all leave the seed in place and write one log line. None of them is shown to the person as an error.

The seed stays because it is free, instant and never wrong about what was asked, only clumsy. A project with no name for the seconds a model takes would show a blank bar or a placeholder, and "Untitled project" is the one name worse than a clumsy one.

**Rejected:** naming the project only when the model answers. That adds a wait to every first turn and leaves a name missing whenever the model call fails.

### D2: The project records where its name came from

`projects.name_source` is `seed`, `model` or `user`. A rename through `PATCH /projects/:id` writes `user`. The first-prompt namer writes `seed`, and only over a name that is still `seed`. A model title writes `model`. Rows that existed before the column are marked `user`, since nothing can tell which of them somebody named by hand, and an old project being titled again is not worth that risk.

### D3: A generation is a token, and a rename always wins

Asking for a title stamps `projects.title_generation` with a fresh id in a conditional `UPDATE`. That stamp is the claim, so two titles for one project are never written at once. A stamp older than two minutes counts as abandoned, so a process that died mid-call does not block the project forever. The model's answer is applied with `UPDATE … WHERE title_generation = <the id it was given>`. Automatic generations also check `name_source <> 'user'`. A user rename sets `name_source = 'user'` and clears `title_generation` in the same statement, so a rename that lands while a title is being written always wins, in either order. This is tested against Postgres.

Automatic titling is attempted at most once per project (`title_auto_attempted`, set by the claim). It is asked for when the project's first prompt is admitted, from both places that admit one: starting a session with a prompt, and the first turn on an unnamed project. The claim makes the two calls one. It runs in the API process, unawaited, while the first turn queues and runs.

### D4: Paid for by whoever pays for the person's turns, on the cheap model

The title call goes through the same `LLMProvider` and the same credential rule as a turn (`resolveTurnAccess`), so it bills the same account:

- **No stored key (free tier):** `NAP_FREE_MODEL` on the deployment's account, as the turn is.
- **An OpenRouter key:** `NAP_FREE_MODEL` on that person's key. It is the deployment's cheap model and is on the allowlist by the boot check.
- **An Anthropic key:** it cannot reach an OpenAI model, so the title uses the model that key's turns default to (the first `anthropic/` entry on the allowlist). Nothing new is configured. The title runs on what the deployment already allows that key.

A title request asks for no tools and at most 64 output tokens, and has `purpose: "title"`, which turns thinking off the way compaction does. The tokens it used are recorded on the `project.renamed` event it writes, beside the model, as `turn.completed` records a turn's.

**Expected cost per title, from list prices (not measured):** the prompt is about 450 tokens. The person's words are capped at 2,000 characters for an automatic title and 4,000 for a regenerated one, so input is at most about 1,000 to 1,500 tokens, and output is under 20. On `openai/gpt-5.6-luna` ($0.10 per million input tokens, $0.60 per million output) that is about **$0.0001 to $0.00016 per title**, or roughly 6,000 to 10,000 titles per dollar. On `claude-sonnet-5` through an Anthropic key ($2 / $10) it is about $0.002 to $0.003. OpenRouter reserves `max_tokens` against the balance before a call; at 64 tokens that reservation is negligible.

### D5: The model's answer is checked before it is used

The answer is trimmed to its first line, and surrounding quotes, a `Title:` prefix and trailing punctuation are removed. It is used only if it has 3 to 8 words and fewer than 40 characters, is not a copy or truncation of the person's message, and is not the session's source name (the repository the card's first line already shows). Anything else keeps the current name. These are T3's editorial rules. T3 states them in its prompt and Nap also enforces them, because a model that ignores an instruction is ordinary.

### D6: Regenerate is the person asking, so it may replace their own name

**Regenerate title** in the row's right-click menu calls `POST /projects/:id/title` and waits for the answer, bounded by the call's timeout. Unlike automatic titling it also runs over a `user` name, because the person asked for it, and the result is `model`. It is refused while a title is in flight and for ten seconds after the last request, so repeated clicks cannot run up the bill on a free-tier account. The row's title is dimmed while one is being written, whether the person asked for it or it is automatic (`titling` on the session summary).

### D7: The change travels on the existing paths

A model title appends `project.renamed` to the project's newest session log and publishes it. An open workspace already refetches its project record when certain events arrive, and this event is one of them. It also tells the sidebar's navigation list to reload over the `nap-sessions` channel. Every other tab gets the name on its next navigation read. Nothing reloads the page.

**Rejected:** carrying the name in the event and applying it in the browser. A stale event replayed on open would overwrite a newer name the person typed. Refetching asks the database, which is always right.

## Consequences

- `project-title.ts` stays, and its "not a model call" note now points here: it is the seed and the fallback.
- Every new project with a first prompt costs one cheap model call, billed like that project's turns.
- Prompt quality is unmeasured. Titles from `gpt-5.6-luna` may be worse than T3's. Spending money to compare them is a separate decision.
