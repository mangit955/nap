# ADR-0008 — The transcript is a derived view, not a chat client

**Status:** Accepted — 2026-08-17

## Context

Nap's chat pane looks like a chat client and is not one. `useEventStream` tails
`/ws?sessionId&seq`, `chat/transcript.ts` folds the resulting `StoredEvent[]` into blocks, and
every other question the pane answers is another fold over the same list: whether a turn is running
(`working-state.ts`), what phase the job is in (`foldJobs`), whether a message the user just typed
has been written down yet (`use-turn-submission.ts`). Nothing in the pane holds authoritative
conversation state, and the three properties that fall out of that were not designed for
individually — reload-safety, agreement between two tabs watching one session, and a replayable UI
are all the same property, which is that there is one source of truth and it is durable.

The obvious thing to do with a chat UI in 2026 is to put a chat runtime under it. assistant-ui is
the good version of that: MIT, actively developed, headless primitives meant for exactly this kind
of custom layout. Because Nap's model runs server-side and reaches the browser as events, the only
integration available is `useExternalStoreRuntime` — supply `messages`, `isRunning` and `onNew`,
and a `convertMessage` into `ThreadMessageLike`.

That integration does not remove the fold. It adds a second one downstream of it, and the second
one is lossy: `ThreadMessageLike`'s roles are `user | assistant | system`, and the transcript's
blocks include `preview`, `preview-stopped`, `notice`, `turn-start`, `turn-end` and a **verifier**
speaker, none of which are any of the three. They would travel in `metadata` and be pulled back out
by custom renderers — which is the code that already exists, plus an adapter.

The features that motivate a runtime are the ones that fit worst. Edit and branch assume the
conversation *is* the state; in Nap a turn's real output is files in a sandbox and a commit in git,
so a branch picker would show a fork the filesystem never performed. Attachments cross six layers —
composer, turn route, `user.message` payload, object store, context-engine truncation order,
`LLMContentBlock` — of which a runtime supplies one. Dictation needs a transcription provider.

## Decision

**The web transcript owns no authoritative conversation state. It derives its presentation from the
session event log, and no client-side chat runtime that maintains an independent mutable
message or thread state is used as a source of truth.**

The rule is about the state model, not about a library. A runtime whose `setMessages` and local
`isRunning` sit beside the log is a second source of truth for facts the log already answers, and
the failure mode is not a wrong pixel — it is two tabs disagreeing, or a reload losing a running
turn. Presentation-only helpers that hold no conversation state are unaffected by this and need no
ADR to adopt.

## Consequences

**Generic chat features are deferred rather than missing, and they are deferred as semantic changes
rather than as UI work.** Editing and branching need Nap semantics first: the honest version of
"branch" here is *revert to this checkpoint and re-prompt*, which is a git operation over verified
commits and has no UI library in it. Attachments need an event payload, a route, storage and a
decision about what the context engine evicts first — a screenshot or the job brief.

**The pane keeps behaviour a runtime would have replaced with something weaker.** `isRunning`
derived from the log survives a reload and a second tab, where a flag set on submit does not.
Retry is offered only when `failure-copy.ts` says the failure is retryable *and* there is a message
to resend, where a generic reload button is always offered and sometimes lies. `step-group.ts`
attributes a tool result by its `toolCallId` rather than to whichever step is last, so an
out-of-order answer cannot blame the wrong command.

**`CONTEXT.md` gains Transcript**, defined against **Session log**: the log is what happened, the
transcript is one rendering of it, and a second view is another fold rather than another copy. That
distinction was doing all the work in this decision while being written down nowhere.

**This is not a rejection of assistant-ui**, and re-opening it on the grounds that the library has
improved would be answering a question nobody asked. What is settled here is where conversation
state lives. Any library that respects that is admissible on its own merits; any library that wants
to own it is not, whatever its version number.
