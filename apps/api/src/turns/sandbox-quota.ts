/**
 * How many sandboxes may be running at once — **advisory, and deliberately not authoritative**.
 *
 * A sandbox is billed for every second it exists, and unlike a model call it keeps costing after
 * the request that made it has been answered. The rate limiter beside this bounds how *fast*
 * someone can spend; this bounds how much they can have running at any moment.
 *
 * **The ceiling that really holds is `SandboxCapacity`, reserved at the point of creation.** What
 * this does is count and then answer, and by the time anything is created that count is old — so
 * under a burst of admissions every one of them reads the same number, finds itself under the
 * limit, and the cap of ten buys a hundred sandboxes. It stays anyway, for two reasons: the
 * obvious case gets a `409` in a few milliseconds instead of after a queue and a cold start, and
 * the message it answers with is the one a person can act on. **Nothing here bounds the bill.**
 * Anything that would change what the cap *means* has to change `PostgresSandboxCapacity`, and a
 * turn this admits may still be refused when its sandbox is actually created.
 *
 * **Only a turn that would create a sandbox is checked.** A session whose project already has one
 * is resuming it, adds nothing to the count, and refusing it would quietly change the meaning of
 * the cap from "sandboxes you may run" to "projects you may talk to" — a user at their limit
 * would find the conversation they were in the middle of had stopped accepting messages.
 *
 * **Two ceilings.** The per-user one is what the milestone asks for. The cluster-wide one is not,
 * and it is the one whose *number* bounds the total bill — enforced at the reservation, echoed
 * here: per-user limits alone mean N strangers cost N times the cap, which is the arithmetic that
 * matters the first time this is shown to anybody.
 *
 * The count comes from `projects.sandbox_id`, which the runtime and the reaper already maintain.
 * A consequence worth knowing: a sandbox reclaimed by the provider behind our back still counts
 * until something notices, so the quota errs towards refusing rather than towards overspending.
 * That is the right direction for a limit whose job is to cap a bill.
 */

import type { ProjectStore } from "@nap/shared/ports/project-store";

export type SandboxLimits = {
  perUser: number;
  /**
   * Across everybody, in every process talking to this database — the count is a query, so a
   * second replica is included in it. Enforcing it is `SandboxCapacity`'s; this only guesses.
   */
  total: number;
};

export type QuotaDecision =
  | { allowed: true }
  | { allowed: false; reason: "per_user" | "total"; message: string };

export type SandboxQuotaCheck = {
  projects: ProjectStore;
  userId: string;
  /** The sandbox already serving this session's project, if there is one. */
  sessionSandboxId: string | null;
  limits: SandboxLimits;
};

export async function checkSandboxQuota(check: SandboxQuotaCheck): Promise<QuotaDecision> {
  // Nothing to create, so nothing to limit — and no query, which keeps the common case (a reply
  // in a conversation already under way) free of a round trip.
  if (check.sessionSandboxId !== null) return { allowed: true };

  const mine = await check.projects.countRunningSandboxes(check.userId);
  if (mine >= check.limits.perUser) {
    // Checked before the global ceiling deliberately: when both are full, the useful thing to
    // say is the one the person asking can do something about.
    return {
      allowed: false,
      reason: "per_user",
      message:
        `You already have ${mine} project${mine === 1 ? "" : "s"} running, which is the limit. ` +
        "Close one from the project list and try again.",
    };
  }

  const everyone = await check.projects.countRunningSandboxes();
  if (everyone >= check.limits.total) {
    return {
      allowed: false,
      reason: "total",
      message: "This server is at its limit of running projects. Try again in a few minutes.",
    };
  }

  return { allowed: true };
}
