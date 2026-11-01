# ADR-0021 — What a summary replaces stays searchable in the sandbox

**Status:** Accepted — 2026-11-01

## Context

[ADR-0016](0016-compaction-preserves-the-event-log.md) made compaction safe for the record:
the log is never rewritten and original user requests survive the summary. It did nothing for
the agent. After a compaction the agent holds a summary, and whatever the summary dropped (the
exact error a build printed, an approach already tried and abandoned, a file path mentioned
once) is still in the log but out of the agent's reach. The agent reads the sandbox, not the
log. The usual result is rework: the agent re-runs a command to see an error again, or
re-reads files to rediscover something it had already established.

## Decision

**Each API compaction writes the conversation it replaces into the sandbox as plain text, and
the summary points into it.**

- **One file per session at `/home/user/.nap/history/<sessionId>.txt`.** Outside
  `/home/user/app`, which is committed every turn, bundled into snapshots, served by the dev
  server and listed to the model and to the Files pane. Under the sandbox user's home rather
  than `/tmp`, which a cleanup is entitled to empty. A dot directory named for Nap, as
  `.nap-desktop` already is.
- **Entries are keyed by event `seq`**, a header line per entry and every other line indented,
  so `^#42 ` matches exactly one line. The log never reassigns a `seq`, so a citation stays
  right after the file is regenerated somewhere else.
- **The file only grows.** Each committed API checkpoint adds one part covering the events
  since the previous one; earlier bytes never change. The summarizer reads a brief form of
  the same rendering, so every number it cites exists in the file.
- **The summary has three sections** (overview, key details with pointers, current state and
  next steps), and the rebuilt context names the file in an application-voice block after the
  quoted summary. That block goes in the messages, not the system prompt, because a compaction
  inside a turn replaces messages and keeps the system prompt it started with.
- **The file is a cache of the log ([ADR-0008](0008-the-transcript-is-a-derived-view.md)).**
  Snapshots carry the project's git history and nothing else, so a replaced sandbox comes back
  without the file. Every turn of a compacted session therefore checks a small record beside
  it and regenerates it from events when it is missing or holds different parts. The agent is
  told the file exists only after a write or check succeeded.
- **The runtime writes it; the context engine renders it.** Writing to a sandbox is a turn's
  side effect, and the component that owns the budget does no I/O.

**Native compaction does not get a file.** A session-backed Claude or Codex provider compacts
its own history with its own summary prompt. We cannot ask that summary to cite our entry
numbers, so the half that makes the file useful is missing. Both CLIs already keep their own
session transcripts. No native provider is composed today, so anything written for that path
would be unverifiable. Nothing is lost by waiting: the file is rendered from portable events
and parts are cut only at API checkpoints, so if a session later compacts on an API route,
the events a native marker covered appear in the next API part.

## Consequences

- A compacted session pays two small sandbox reads per turn. A compaction, or a sandbox
  without the file, pays one write of the whole history. Sessions that were never compacted
  pay nothing.
- The file grows with the session and is never trimmed. Tool output is already capped by the
  tools that produced it, which bounds each entry but not the total.
- The three-section shape is requested, not enforced. Rejecting a summary with a missing
  heading would discard a paid call while the context is still too full.
- The agent can edit or delete its copy with a shell command. The next turn notices a deleted
  file but not an edited one, and the log is unaffected either way.
- The summarizer's input changed from JSON-encoded provider messages to the brief rendering.
  Old turns' tool output is elided from it as before (ADR-0011), so a summary call costs about
  what it did.

Mechanism, format and verification are in [the compaction notes](../compaction.md#compaction-history).
