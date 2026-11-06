# ADR-0021 — An event append is one statement on a per-session counter

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
- **The retried append (`retryAfterSeq`) stays a transaction.** It first locks the same counter row `for no key update`, which waits out an interrupted attempt still in flight. It then looks for the event above the watermark, and inserts through the same statement only if it is absent. Retries are rare, so their extra round trips do not matter.
- `unique(session_id, seq)` remains the backstop. It can only fire when two writers that both bypassed the counter race each other.

Migration `0017_session_head_seq` adds the column with a constant default, which is metadata-only, and backfills each session from `max(seq)`. The floor means the backfill is tidiness rather than what keeps a session writable.

## Consequences

- Invariant §21.1 (gapless, monotonic `seq` under any number of writers) holds unchanged. `postgres-event-store.db.test.ts` proves it from four separate connections, and fails when the counter is replaced by a bare `max(seq) + 1`.
- Seqs still become visible in commit order. That is what lets the runtime read a session's log incrementally (`SessionHistory`), asking only for what is above the last `seq` it saw.
- A session row is rewritten on every append. The row is narrow, `head_seq` is not indexed, and nothing else writes it during a turn, so the updates can be HOT and the lock is uncontended.
- During a rolling deploy, an old-release writer and a new-release writer appending to the *same* session at the *same* moment can still collide once, on the unique index. The lease makes that overlap unlikely. If it happens, it fails one append as `23505`, the error a bare race always produced, and leaves the session wedged no longer than that one append.
