# ADR-0018: Execution is exclusive per project

**Status:** Implemented offline, 2026-10-24. Native providers remain disabled.

Sessions in one project share files, git state and preview processes. A per-session queue lease
allows two workers to edit that workspace concurrently. Native finalization cannot treat its
own conversation as the only writer while an API turn in a sibling session is still running.

The queue therefore retains its session uniqueness rule and adds a partial unique index over
leased project IDs. A database trigger derives project identity from the session on insertion
and rejects conflicting supplied identity. Existing requests are backfilled before the new
constraint is applied. Admission does not accept a project claim in the queue request contract.
Claim still selects a candidate and updates it in one transaction, steps over busy projects,
and retries only the two known lease-constraint violations. It never requeues a started request.

An unresolved native run continues to block later API and subscription claims after its queue
lease expires or ends. A native run is released only after its supervisor's termination proof
is verified and recorded. Other projects remain claimable. This rule does not establish native
tool isolation or prove that preexisting preview processes cannot mutate files.

`TurnQueue.isBusy` replaces `anyLeased` across composition and callers. It covers the projects
containing the supplied sessions and reports leased requests or unresolved native runs. Close,
delete and idle-sweep checks therefore preserve the same physical fence used by admission to
execution. This remains an observation rather than a teardown lock. The stronger lifecycle and
filesystem barrier required by native execution is a separate release gate.

Migration `0020_project_turn_exclusion` requires draining old API, workers and reaper before
application. Stop old processes first, then reconcile stale durable leases through the existing
janitor after their grace window. Before applying the migration, confirm
`SELECT count(*) FROM turn_requests WHERE state = 'leased';` returns zero. Expiry alone does
not change a leased row's state. Do not delete or requeue started work to satisfy this preflight;
the migration deliberately refuses incompatible old leased siblings. Old workers do not recognize the project constraint or native fence. The upgrade
test applies earlier migrations to an isolated database, inserts old-format work, applies the
current migration, and verifies that the existing work retains its project and can run while
its sibling waits. No production migration has run.
