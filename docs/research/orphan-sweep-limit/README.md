# Orphan sweep limit diagnosis, issue #175

Base: `c31107e`, isolated worktree `/Users/manasraghuwanshi/.t3/worktrees/nap/t3-e31149a4`.
Only `packages/db/src/postgres-turn-queue.ts` and its `.db.test.ts` are changed.
The parent's pending recording UI diff is not in this checkout. No paid calls, builds,
subagents, push, PR, or unrelated source edits were used.

## Finding

The public `PostgresTurnQueue.orphanExpired(2)` returns three rows on real PostgreSQL 17
with default planner settings when `ANALYZE turn_requests` observes one expired leased
row and two further expired leases are added before statistics refresh. This reproduced
on fresh containers, including the final transaction-scoped regression before the fix.
The transaction holds ANALYZE's table lock until completion so autoanalyze cannot refresh
the deliberately stale statistics halfway through the regression.

Captured SQL parameters were `['orphaned', '30000 milliseconds', 2]`. Catalog estimates
were `reltuples=1`, `relpages=1`. `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` of that exact
parameterized statement reported:

- `ModifyTable`: actual rows 3, loops 1.
- `Nested Loop`, semi join: actual rows 3, loops 1.
- Inner `Subquery Scan`, `Limit`, and `LockRows`: actual loops 3.

The locking subquery can be rescanned for each outer row. Its result changes as the
statement updates rows, so its per-execution LIMIT does not bound the whole UPDATE.
This is a query correctness bug, not an ORM result duplication or incorrect limit argument.
The original full-run failure did not capture its plan; the exact statistics and timing of
that run remain unknown. This reproduction proves the same public-query failure without
requiring another suite or concurrency, rather than claiming to have recovered that plan.

## Repair

Move the same ordered, parameterized `FOR UPDATE SKIP LOCKED LIMIT` selection into a
named locking CTE, then update only its IDs. Keep Drizzle's typed RETURNING projection.
PostgreSQL materializes a CTE containing row locks, so the candidate query executes once.
The CTE scans may repeat; the locking selection may not. The captured fixed plan has
`Limit`/`LockRows` loops 1, CTE scan loops 3, and UPDATE actual rows 2.

The SQL does not spell MATERIALIZED: installed Drizzle 0.45.2's CTE builder has no such
option. PostgreSQL's `SS_process_ctes` forbids inlining when `contain_dml` sees `rowMarks`,
which includes this FOR UPDATE. See the [PostgreSQL 17 planner source](https://github.com/postgres/postgres/blob/REL_17_STABLE/src/backend/optimizer/plan/subselect.c).
The failure mechanism also matches this [PostgreSQL maintainer explanation](https://www.postgresql.org/message-id/632644.1669655513%40sss.pgh.pa.us).

Retain raw SQL inside the CTE to preserve parameter binding for invalid limits. During
self-review, a typed-select draft using `.limit(limit)` was found to silently omit negative
and NaN limits in installed Drizzle. Its new compatibility test failed, then passed with
the original SQL LIMIT interpolation restored. No extra runtime validation was added.

Grace, oldest-expiry priority, row exclusion, owner/state fencing, no requeue, and null
announcement markers are unchanged. Claim/project locks are untouched.

## Hypotheses and probes

1. Planner rescans caused by catalog estimates: confirmed. Analyzing exactly one row is
   sufficient; no planner GUCs, prepared statement, extra index, or fabricated schema is needed.
2. State selectivity alone: insufficient in 36 probes. Counts 0/1/3/10/100/1000 of historical
   rows, done/queued/leased distributions, and keeping/deleting history all passed when
   ANALYZE observed at least three rows. Empty-table ANALYZE also passed.
3. Parent's forced nested-loop/generic-plan theory: not enough by itself. Its preserved plan
   put Unique/Sort/Limit on the outer side and correctly selected two. That experiment did
   not reproduce the failing join direction. No claim that its result was wrong.
4. Wrong parameters, result duplication, or prepared generic-plan caching: the captured
   parameters and actual UPDATE row count rule these out for the deterministic failure.
   Installed Drizzle calls postgres.js `unsafe`, whose default is `prepare:false`.
5. Other-suite rows or concurrent mutation: unnecessary for the deterministic reproduction.
   DB files are serial on one throwaway container per run. No other DB tests explicitly
   ANALYZE or change planner settings. Autoanalyze timing remains a plausible explanation
   for full-run intermittency, not an observation from the original run.

## Tests and evidence

Original evidence is preserved unchanged:
- `/tmp/nap-computer-integrated-full.log`: 5499 passed, 1 failed, expected 2 / actual 3.
- `/tmp/nap-queue-limit-isolated.log`: parent's focused passing run.
- `/tmp/nap-orphan-query-plan.json`, `/tmp/nap-orphan-rescan-plan.log`: parent's passing probe.

New evidence:
- `/tmp/nap-175-one-row-stats-red.log`, `/tmp/nap-175-repeat-red.log`: fresh-container failures.
- `/tmp/nap-175-regression-red.log`: final transaction-scoped regression, expected 2 / actual 3.
- `/tmp/nap-175-actual-query-plan.json`: actual failing SQL, parameters, catalog, settings, plan.
- `/tmp/nap-175-fixed-query-plan-final.json`: final SQL, parameters, and fixed plan; locking
  selection executes once. `/tmp/nap-175-final-plan-green.log` records the passing probe.
  `/tmp/nap-175-fixed-query-plan.json` preserves the earlier typed-select draft plan.
- `/tmp/nap-175-probes.jsonl`, `/tmp/nap-175-statistics-probe.log`: all 36 earlier passing probes.
- `/tmp/nap-175-statistics-probe.test.ts`, `/tmp/nap-175-plan-probe.test.ts`: scratch probes.
- `/tmp/nap-175-builder-limit-red.log`: typed-select draft incorrectly accepts a negative limit.
- `/tmp/nap-175-final-queue-green.log`: all 56 queue tests pass on the final source.

Mutation checks, all failed for their intended reason and were restored:
- `/tmp/nap-175-mutation-inline-rescan.log`: old inline query returns 3 instead of 2.
- `/tmp/nap-175-mutation-no-skip-locked.log`: overlapping janitor waits and hits lock timeout.
- `/tmp/nap-175-mutation-no-grace.log`: still-protected lease is incorrectly orphaned.

The overlap test holds the first janitor's transaction open, runs a second connection,
checks disjoint two-row batches in expiry order and a one-row remainder, then confirms
that stale renewal and settlement fail and announcement markers remain null.

The first two baseline attempts here could not load Vitest because this fresh worktree
had no dependencies. They are setup failures, not red reproduction evidence. A frozen
lockfile install resolved this without changing tracked dependency files.

## Gates and handoff

- Typecheck passed, including all 14 workspaces and the root pass: `/tmp/nap-175-typecheck.log`.
- Lint passed with one existing CSS warning and one existing sandbox-test info finding:
  `/tmp/nap-175-lint.log`. Neither file was edited.
- Collection lists all 56 queue tests, including the three affected orphan-sweep tests:
  `/tmp/nap-175-collection.log`.
- Existing DB glob, package typecheck include, Biome scope, and architecture rules cover both
  files. No package imports, test projects, hooks, or CI changes are needed. Pre-commit intentionally
  excludes DB tests, so these real-Postgres runs supplement it.
- Full `bun run test --maxWorkers=2` passed: 5,410 tests across 412 files, no type errors,
  including architecture/comments tests: `/tmp/nap-175-full-test.log`. This count excludes
  the parent checkout's uncommitted recording tests.
- Local commit `08ccc3e735f35a6deb61f6cb8895422f38e836cd` on `t3/fix-orphan-expiry-limit`.
- Pre-commit Biome, typecheck, and changed unit/web hook passed; the latter had no matching
  tests because the changed suite belongs to DB. Full DB coverage is recorded above.
  Hook output: `/tmp/nap-175-commit.log`. Working tree clean after commit.
Issue stays open for the parent's independent review and integration. No monitoring started.

## Parent integration

The parent integrated this repair with the recording and computer UI changes. The full serial gate passed 5,514 tests across 418 files; typecheck, lint and a frozen dependency install passed. The preceding parallel run retained one unrelated Git-helper readiness timeout. Its isolated eight tests and the serial full gate passed. No test timeout or Git broker behavior was changed. The independent review found no correctness defects; its comment-only suggestion is included beside the locking CTE.
