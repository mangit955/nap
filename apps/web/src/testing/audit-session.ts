/**
 * One real session, kept.
 *
 * `events.ts` and `job-events.ts` beside this build events by hand, which is right for a test
 * whose subject is ordering or a job's shape — the story is the point and the numbers are
 * noise. This is the opposite kind of fixture: **nobody wrote it.** It is the log a funded run
 * against real E2B and a real model actually produced, dumped out of Postgres unedited.
 *
 * That matters for the surfaces that are folds over the log rather than assertions about it.
 * A hand-written fixture answers "does the fold handle a repair", and a real one answers "what
 * does this look like when a model spends four turns on a finance dashboard" — how long the
 * objectives are, how many actions land in a group, how much prose arrives between them. Every
 * one of those is a layout question, and hand-written events are uniformly too tidy to ask it.
 *
 * **What is in it**, and why it was worth the money:
 *
 *   - **Four jobs, and one of them failed.** Three verified; the fourth abandoned on
 *     `budget_exceeded` after 403,478 tokens against a 400,000 limit. A history panel that
 *     only ever sees green is a history panel nobody checked against a red row.
 *   - **Two checks came back `absent`**, because the generated project declares no lint and no
 *     test script. That is the case `docs/adr/0002` is about and the one most easily confused
 *     with failure, so it is worth having a real instance of rather than a constructed one.
 *   - **A `turn.failed`** carrying the reason `failure-copy.ts` deliberately answers with
 *     `rephrase` rather than `retry`.
 *   - Real thinking passages, 39 tool calls, 29 file changes and a `preview.ready`.
 *
 * The ids and the sandbox URL belong to a throwaway local database and a sandbox that has long
 * since been reclaimed; there is nothing here to keep secret.
 */

import { NapEventSchema } from "@nap/shared/events";
import type { StoredEvent } from "@nap/shared/ports/event-store";
import raw from "./audit-session.json" with { type: "json" };

/**
 * The log, parsed.
 *
 * Validated on the way out rather than trusted, because a fixture that has quietly stopped
 * matching the event contract is worse than no fixture: every test reading it keeps passing
 * while describing a shape the system no longer produces. `audit-session.test.ts` is what
 * makes that failure loud.
 */
export function auditSession(): readonly StoredEvent[] {
  return raw as readonly StoredEvent[];
}

/**
 * Every event that no longer matches the contract, said in a sentence.
 *
 * The *whole* event is parsed, envelope included, rather than the payload alone: each member of
 * `NapEventSchema` is a `strictObject` carrying `sessionId`, `turnId`, `seq` and `createdAt`
 * beside `type` and `payload`. Strict is the useful part — a field the log has grown and the
 * union has not is as much a drift as a field it has lost.
 */
export function auditSessionIssues(): string[] {
  const issues: string[] = [];

  raw.forEach((event, index) => {
    const parsed = NapEventSchema.safeParse(event);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      const at = first === undefined ? "" : ` at ${first.path.join(".")}`;
      issues.push(`[${index}] ${event.type}${at}: ${first?.message ?? "invalid"}`);
    }
  });

  return issues;
}
