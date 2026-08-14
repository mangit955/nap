# Context

The words this codebase uses for the things it is about, so that one concept has one name. Added
to when a term actually gets resolved rather than upfront — see `docs/agents/domain.md`. What v1
*is* lives in `docs/PLAN.md`; why the code is shaped the way it is lives in `docs/GOTCHAS.md`.

## Glossary

**Project** — what a user is building: a name, an owner, files, and at most one sandbox serving it
at a time. Outlives every sandbox it ever had.

**Session** — one conversation about a project. A project's newest session is the one its workspace
opens; a link never names a session, because the project grows new ones.

**Turn** — one exchange within a session: a user message, whatever the agent does about it, and
exactly one terminal event (`turn.completed` or `turn.failed`). The unit budgets, cancellation and
commits are all scoped to.

**Event** — one durable, ordered fact about a session, identified by its `seq`. Appended to the
store *before* it is published to the bus, never the other way round.

**Session log** — the ordered, append-only run of a session's events *as a client holds it*: one
socket, one `seq`, many derived views. Distinct from the `EventStore`, which is where events live;
the log is one reader's copy of them. In the browser it is `useSessionLog`, and there is one per
workspace — a second one is two clients that can disagree about what the newest event was.

**Sandbox** — the isolated machine a project's code is written into and served from. Reclaimable at
any time, by the reaper or by the provider's own timer, which is why no view may treat "there is a
`preview.ready` in the log" as "something is running".

**Put away** — a project whose sandbox has been destroyed on purpose, its work preserved in a
snapshot. Not an error and not an empty project: its files are safe, and starting it back up takes
seconds. The state a project spends most of its life in.

**Snapshot** — the archived filesystem of a put-away project; what a restore rebuilds from.

**Preview** — the user's app, running in a sandbox and reachable at a URL announced by
`preview.ready`. The `seq` of that announcement, not its URL, is what identifies *which* preview:
a project put away and restarted has two announcements and only one live sandbox.
