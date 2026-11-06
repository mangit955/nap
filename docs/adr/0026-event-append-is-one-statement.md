# ADR-0026 — An event append is one statement on a per-session counter

**Status:** Accepted, 2026-11-06. Measured on the db suite's Postgres container: four statements per append before, one after. Not yet measured against a deployed database.

## Context

`docs/scaling-design.md` §1 and §17 (B-3) describe `PostgresEventStore.append` as it was when the design was written: a transaction that takes `pg_advisory_xact_lock(hashtext(session_id))`, inserts at `max(seq) + 1`, and commits. That is four round trips per event: `BEGIN`, the lock, the insert and `COMMIT`. `EventSink` appends a turn's events strictly one at a time, because order is the contract, so each round trip is a delay on every streamed text delta and every tool event the person is watching. The agent persists streamed text every 120 characters or 400ms, so a turn writes many events.

## Decision

`sessions` gains `head_seq`. An append is one statement:

```sql
with next as (
  update sessions set head_seq = greatest(head_seq, (select coalesce(max(seq), 0) from events where session_id = $1)) + 1
  where id = $1 returning head_seq)
insert into events (…, seq, …) values (…, coalesce((select head_seq from next), 0), …) returning *
```

- **The row lock is the serialization.** A second writer blocks on the `UPDATE`. Once the first commits, Postgres re-evaluates the row it waited on and hands the second writer the incremented value. This is cluster-wide, as the advisory lock was.
- **An advisory lock cannot do this in one statement.** The statement's snapshot is taken before the lock is granted, so a `max(seq)` read through it after waiting does not see the writer it waited for, and the two collide.
- **`max(seq)` is a floor, not the serialization.** A row can reach `events` without advancing the counter: the previous release during a rolling deploy, or a fixture inserting rows directly. Without the floor, that session's every later append would collide on `unique(session_id, seq)`. With it, the next append catches up. The cost is one backward step on the `(session_id, seq)` index, which is what the old subquery already paid.
- **A missing session still fails on the foreign key (`23503`).** The `UPDATE` matches no row, `seq` falls back to 0, and the insert reports the missing session as it always has. The sink treats `23503` as permanent.
- **The retried append (`retryAfterSeq`) stays a transaction.** It first locks the same counter row `for no key update`, which waits out an interrupted attempt that already holds that row, or is queued for it ahead of the retry. It then looks for the event above the watermark, and inserts through the same statement only if it is absent. Retries are rare, so their extra round trips do not matter.
- **That wait is narrower than the advisory lock's was, and this is the trade accepted for one round trip.** The old append sent its insert only after it held the lock, so an attempt whose client had gone could commit only if it was already holding it. A single statement is executed by the server once received, client or no client. An attempt that the server has received but that has not reached the row lock yet — queued behind another writer of the same session, or held in a pooler — can still commit after the retry has looked, found nothing and inserted, and the event is then in the log twice. `seq` stays gapless; the duplicate is what is lost. It needs a transient client-side failure (a reset or a timeout, which is what makes the sink retry) while another writer is contending for the same session's row. If it ever matters, the fix is a client-generated event id under a unique constraint, so the database refuses the duplicate rather than the retry looking for it.
- `unique(session_id, seq)` remains the backstop. It can only fire when a writer that bypassed the counter races another writer.

Migration `0018_session_head_seq` adds the column with a constant default, which is metadata-only, and does not backfill it. A backfill would scan all of `events` under the `ALTER`'s exclusive lock on `sessions` — drizzle's `migrate()` runs pending migrations in one transaction — during the pre-deploy step, while the previous release is still serving and needs `sessions` for every append. It is not needed: an existing session starts at `head_seq = 0`, and the floor takes its first append under the counter to `max(seq) + 1`.

## Consequences

- Invariant §21.1 (gapless, monotonic `seq` under any number of writers) holds unchanged. `postgres-event-store.db.test.ts` proves it from four separate connections, and fails when the counter is replaced by a bare `max(seq) + 1`.
- Seqs still become visible in commit order. That is what lets the runtime read a session's log incrementally (`SessionHistory`), asking only for what is above the last `seq` it saw.
- A session row is rewritten on every append. The row is narrow, `head_seq` is not indexed, and nothing else writes it during a turn, so the updates can be HOT and the lock is uncontended.
- During a rolling deploy, an old-release writer and a new-release writer appending to the *same* session at the *same* moment can still collide once, on the unique index: the counter writer's floor reads through a snapshot that cannot see a bypassing row committed after it was taken. The lease makes that overlap unlikely for a turn's appends, though not every append is under one — a GitHub webhook's `system.notice` (`GitHubIntegration.notice`) and the close and reaper announcements write outside any lease. If it happens, the append fails as `23505`, the error a bare race always produced. The sink treats that as permanent and its failure is sticky, so it fails the turn it belongs to, not only that event. The session is not wedged: the next append's floor sees the committed row.
