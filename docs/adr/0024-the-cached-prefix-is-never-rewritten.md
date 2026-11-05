# ADR-0024 — The cached prefix is never rewritten

**Status:** Accepted — 2026-11-03. Amends [ADR-0011](0011-an-old-turns-tool-traffic-is-not-worth-carrying.md):
*every finished turn* is stale, where it said *every turn older than the most recent one*. Amends
[ADR-0020](0020-the-agent-loop-grows-a-registry-and-seams.md): a repair turn declares a tool it is
not offered.

## Context

A provider caches a prompt by prefix. The request renders as tools, then the system prompt, then
the messages, and a byte that differs anywhere loses everything after it. Within a turn this
worked: the loop re-sends one prompt and an append-only conversation, and the last block's
breakpoint moves along with it. **Across turns it never worked**, for three independent reasons,
each enough on its own:

1. **The system prompt carried what changes.** It held the instructions, the file listing, the job
   brief and memories, behind one breakpoint. A turn that added a file changed the listing; a repair
   turn changed the brief. Either one made the tools-plus-system prefix miss, and the whole
   conversation behind it with it. The comment claiming the brief's position protected the cache
   was wrong: with one block and one marker, order inside the block changes nothing.
2. **History was rewritten one turn late.** The most recent finished turn kept its tool traffic and
   lost it a turn later, so every turn's first request emptied a turn that the previous request had
   sent whole, in the middle of history that was otherwise settled.
3. **A repair turn declared one tool fewer.** Tools render first, so dropping `ask_user` from a
   repair turn's declarations missed the entire prefix, on that turn and on the person's turn after.

So the first call of every turn and every repair re-wrote the full context at the cache-write price
(1.25× on Anthropic models against 0.1× for a read) and waited for it before the first token.
OpenAI's caching through OpenRouter is automatic but also prefix-based, so the models used in
practice paid the same way.

## Decision

**Nothing a later request will repeat is rewritten, except at a compaction.**

- **The system prompt is the instructions for the workspace and nothing else** — the same bytes for
  every user, session and turn. The file listing, the job brief and memories ride at the end of the
  turn's own message, the one part of the request that is new anyway. That is also the honest role
  for them: file names and quoted check output are project data, not trusted instructions.
- **Every finished turn is stale**, emptied at the end of the turn that wrote it, where the request
  changes anyway. *Finished* is read from the log — the turn's `turn.completed` or `turn.failed` is
  there — not from its position or from what the caller calls the build, so a turn still running
  keeps its traffic through any rebuild in its middle, and the exchange a compaction kept belongs to
  the turn it came from and goes stale with it. A question to the person is exempt: an `ask`-kind
  tool's arguments are conversation, and the turn that answers is the first one on which the asking
  turn is finished.
- **A repair turn declares a person's tool set.** The executor already refuses any tool a turn was
  not offered; it refuses `ask_user` there with an immediate answer, so nothing waits on a question.
- **The context engine marks settled history** with `cacheBreakpoint` on two messages: the end of the
  previous turn's history, which this request reads, and the end of this one's, which the next turn
  reads. The provider adds the system prompt's and the moving one at the end — four, the ceiling. The
  read needs a marker of its own because one turn's traffic is routinely more blocks than the API
  looks back from a breakpoint for an earlier entry. A provider with automatic caching ignores them.

Whatever the budget ladder, the turn window or a compaction rewrites also sets `needsCompaction`, so
the one remaining rewrite is the one that replaces history with a summary anyway.

## Consequences

**Staleness one turn sooner saves tokens rather than costing them.** On the committed audit session
(`bun packages/context/scripts/measure-audit-session.ts apps/web/src/testing/audit-session.json`,
local estimates, which run about half the provider's count), turn 4 assembles to 2,465 tokens
instead of 7,249, and re-sends 34,510 across its fourteen steps instead of 101,486. The price is the
one ADR-0011 already accepted, paid a turn earlier, and it is wider than file contents: the agent may
re-read a file it touched in the previous turn, a helper's report from that turn is gone and costs
another helper run to recover, and a plan left open at the end of a turn is gone on the turn that
continues it. Each is paid only when the contents matter.

**`packages/agent/src/cache-prefix.test.ts` is the guard.** It assembles the first request of three
consecutive turns of one session — one after a turn that added a file, one a repair with a job brief
— renders each with the real request mapper, and asserts that every prefix the earlier request
cached is repeated byte for byte at a breakpoint of the later one, history included. Each of the
three causes above fails it.

Cross-turn reuse pays only when the next turn starts inside the cache's lifetime, five minutes on
Anthropic models. A repair starts at once and is where this pays most; a person who reads the preview
for longer before replying gets the system prompt from another session's entry, and history from
nothing.

**A compaction costs one more, smaller write on the turn after it.** The exchange a compaction kept
is sent verbatim while its turn runs and stale once that turn has finished, so the next turn's first
request diverges just after the summary and writes it again, with the stale stubs behind it — a few
thousand tokens, since history was just compacted. The turn after that reads it back.

**A turn whose end is written late, or never, stays verbatim until it is closed.** After a worker
crash the janitor writes the turn's `turn.failed` on its next tick, and a build in that gap sends the
dead turn's tool traffic whole; once the failure lands, the next build empties that turn and rewrites
history from it onward, once. A turn that is never closed keeps its traffic for good, in bytes that
do not change, until the window or a compaction drops it.

**A repair turn can spend a step on a question nobody can answer.** It declares `ask_user` and is not
offered it, so a model that calls it anyway gets an immediate refusal saying so and a round trip is
gone. The tool's description says it is only for a turn a person started, in bytes every turn shares.

**App-test turns still declare a different set**, read-only by design, so an app test's own requests
and the person's turn after it miss the history cache. Declaring every tool and refusing all but the
test's at execution would fix it and touch the app test's look-but-don't-touch guarantee, so it needs
its own decision.

**The listing is unavailable rather than absent when it fails.** It moved into the same change for
the same first-token reason: it is now one sandbox call (`SandboxManager.listTree`) with a five-second
deadline, and a failure tells the model to list the project itself rather than reading as an empty one.
The walk over it and its limits are unchanged; what it is fed is not quite the old walk's view. A
repository's gitignored files are left out, by design. A file deleted or moved and not yet committed
is listed where it is on disk, not where the index says. The fallback for a workspace without git
lists regular files only, so symlinks are gone. And a listing cut at its byte ceiling is whatever
was printed first, not the shallowest files: from git, the tracked files before any untracked one,
each in git's order; from the fallback, directory order.

**Measured once on the default model, for about a cent.** Three short turns in one session on
`openai/gpt-5.6-luna` through OpenRouter, in-memory sandbox, before and after this change. Before,
the first request of the turn after one that added a file read nothing and wrote all 2,471 tokens.
After, every turn's first request read the 2,090-token tools-and-system prefix — including the very
first turn of a fresh session, from an earlier session's entry. What this route did *not* do is read
at the settled-history breakpoint on turn 3, although the request bytes up to it were verified
identical to turn 2's; within a turn it reads at the moving breakpoint as expected. History reuse
across turns is therefore shown by the guard test and the request bodies, and has not been observed
in billing on a Claude model.
