# Review: 08ccc3e `fix(db): bound orphan sweeps across query plans` (#175)

Scope: read-only review of the orphan-sweep repair only. I made no source edits, spawned no
subagents, made no paid calls, ran no builds and did not push. Diff is two files:
`packages/db/src/postgres-turn-queue.ts` and its `.db.test.ts`. Base `c31107e`, worktree clean.

## Verdict

**No correctness bugs found.** There is one low-severity comment regression (below). It is
optional and does not block integration.

## What was checked

- **Rendered SQL** (from `/tmp/nap-175-fixed-query-plan-final.json`):
  `with "expired_requests" as (select id … where state='leased' and lease_expires_at < now() - $1::interval
  order by lease_expires_at for update skip locked limit $2) update "turn_requests" set "state" = $3
  where "turn_requests"."id" in (select "id" from "expired_requests") returning "id","session_id","kind","message"`.
  - Grace, expiry ordering, SKIP LOCKED and the `$2` LIMIT binding are the same as the original inner query.
  - The RETURNING projection is the same typed shape (`OrphanedTurnRequest`).
  - `finished_at` and `lease_expires_at` are still untouched, so announcement markers keep their meaning.
  - The `set` is still only `state`, and the owner/state fencing in `renew` and `settle` is unchanged.
- **Execute-once claim.** In the fixed plan, `Limit`/`LockRows` under `CTE expired_requests` run
  with loops 1 and return 2 rows; the `CTE Scan` runs with loops 3, and ModifyTable returns 2 rows.
  The catalog was the same stale `reltuples=1, relpages=1`. PG ≥12 inlines a CTE only when
  `!contain_dml`, and `contain_dml` is true when there are `rowMarks`, so FOR UPDATE keeps the CTE
  materialized. Tests use `postgres:17-alpine`. Drizzle 0.45 has no `MATERIALIZED` option, so
  depending on the rowMarks rule is reasonable.
- **READ COMMITTED semantics.** The CTE's FOR UPDATE re-checks the quals against the newest row
  version (EvalPlanQual). A row renewed or settled after the snapshot is therefore dropped and never
  reaches the UPDATE. Rows the CTE emits are locked by this statement until commit, so the outer
  UPDATE without a `state` predicate cannot race. This matches the original form's guarantees.
- **Invalid limits.** The raw `limit ${limit}` binding is kept. Negative values and NaN still reach
  Postgres and raise an error, as before; the earlier typed `.limit()` draft dropped them silently.
  The new test covers both and checks that the row stays `leased`. Limit 0 returns `[]` (covered).
- **Tests.**
  - The stale-statistics regression runs inside one transaction, so the ANALYZE lock blocks
    autoanalyze. On the fixed query it passes whatever plan Postgres picks, so it is not flaky
    once fixed. It reproduces red only for the plan-dependent old query, which is expected for
    this kind of test.
  - `beforeEach` deletes `turn_requests`, so the whole-table `state='leased'` count of 1 is safe.
  - The overlap test needs a second connection. The pool is `max: 24`, and `lock_timeout: 2000`
    makes a broken SKIP LOCKED fail rather than hang.
  - The removed "takes no more than the limit in one tick" test is replaced by the 2-then-1
    sequence in the stale-statistics test, so no coverage is lost.
- **Guards not reduced.** The parent's mutation logs show the inline query returning 3 instead of 2
  (`/tmp/nap-175-mutation-inline-rescan.log`, confirmed). The diagnosis also records failures for
  no-SKIP-LOCKED (lock timeout) and no-grace.
- **Reruns.** The focused file passed 56/56 three times in a row
  (`vitest run --project db packages/db/src/postgres-turn-queue.db.test.ts`), recorded in
  `/tmp/nap-orphan-limit-review-run.log`. I did not run the full gate.

## Findings

1. **Low: rationale comment dropped.** `packages/db/src/postgres-turn-queue.ts:366-375`.
   - The diff deletes the comment explaining *why* `for update skip locked`: two janitors ticking
     at once, as in a rolling update, step over each other's rows rather than wait. It also deletes
     why ordering is by expiry: the longest-spinning chat pane closes first. The new comment covers
     only materialization.
   - `docs/scaling-design.md` §5 and `docs/GOTCHAS.md` (reaper/janitor bullet) still state the
     reasoning, so nothing is lost project-wide. Locally, though, a reader could "simplify" away
     SKIP LOCKED or the ORDER BY. The no-skip-locked mutation test would catch the first; only the
     overlap test's expiry-order assertion would catch the second.
   - Reproduction: `git show 08ccc3e -- packages/db/src/postgres-turn-queue.ts` shows the removed lines.
   - Fix: put the two sentences back above the CTE next to the new one. Comment-only; no behaviour change.

## Limits of this review

- I did not reproduce the original full-gate failure (`/tmp/nap-computer-integrated-full.log`). The
  diagnosis notes its plan was never captured. The deterministic one-row-statistics reproduction
  shows the same public failure (2 → 3), and the fix makes that query plan-independent.
- I did not inspect Postgres versions in production; any PG ≥12 behaves as above, and PG <12
  always materialized CTEs.
- I did not run concurrency stress beyond the two-connection overlap test.
- The parent's integration run is still pending.
