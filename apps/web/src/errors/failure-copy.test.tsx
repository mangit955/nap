/**
 * `.tsx` with no JSX: filename decides the vitest project, and this belongs with the other web
 * tests rather than in the Node `unit` project.
 *
 * The interesting test here is the last one. Five hand-written strings are easy to get right
 * once; what goes wrong is the sixth failure reason added a year from now, whose copy is either
 * missing or is "Something went wrong". Both are caught below without anybody remembering to
 * come back here.
 */

import { TurnFailureReasonSchema } from "@nap/shared/events";
import { describe, expect, it } from "vitest";
import { requestFailureCopy, turnFailureCopy } from "./failure-copy.ts";

/**
 * Phrases that say a failure happened without saying anything about it. Modelled on the way
 * `system-prompt.test.ts` pins an absence — a list is crude, and it is the only thing that turns
 * "no generic messages" from an intention into a gate.
 */
const GENERIC = [
  /something went wrong/i,
  /unexpected/i,
  /an error occurred/i,
  /try again later/i,
  /please try again\.?$/i,
  /^error/i,
  /^failed\.?$/i,
];

const EVERY_REASON = TurnFailureReasonSchema.options;

describe("each failure mode says what happened and what to do", () => {
  it("names the sandbox as the thing that failed, and offers a retry", () => {
    const copy = turnFailureCopy("sandbox_unavailable", "E2B returned 503");

    expect(copy.title).toMatch(/workspace/i);
    expect(copy.recovery).toBe("retry");
    // The server's own words are kept as detail rather than thrown away: "E2B returned 503" is
    // the only part that distinguishes this failure from the next one.
    expect(copy.detail).toContain("E2B returned 503");
  });

  it("distinguishes the model declining from the machinery breaking", () => {
    // Both are "agent failure" and they need different things from the user: one is a rephrase,
    // the other is a retry of exactly the same message.
    const refusal = turnFailureCopy("refusal", "");
    const internal = turnFailureCopy("internal", "boom");

    expect(refusal.title).not.toBe(internal.title);
    expect(refusal.action).toMatch(/rephrase|different|another way/i);
    expect(internal.recovery).toBe("retry");
  });

  it("tells a budget-exceeded turn to ask for less, not to try the same thing again", () => {
    // Retrying an identical request that ran out of steps spends the whole budget again and
    // fails in the same place, which is the least useful advice available.
    const copy = turnFailureCopy("budget_exceeded", "");

    expect(copy.action).toMatch(/smaller|less|narrow|break/i);
    expect(copy.recovery).not.toBe("retry");
  });

  it("says nothing alarming about a turn the user cancelled", () => {
    const copy = turnFailureCopy("cancelled", "");

    expect(copy.recovery).toBe("none");
    expect(copy.title).toMatch(/stopped|cancelled/i);
  });
});

describe("refused requests", () => {
  it("tells a rate-limited caller to wait, carrying the server's own wait time", () => {
    const copy = requestFailureCopy(429, "rate_limited", "Too many turns. Try again in 4 minutes.");

    expect(copy.recovery).toBe("wait");
    expect(copy.detail).toContain("4 minutes");
  });

  it("tells a quota-blocked caller to close a project, which is a different action", () => {
    const copy = requestFailureCopy(409, "sandbox_quota_exceeded", "You already have 2 running.");

    expect(copy.recovery).toBe("close-project");
    expect(copy.action).toMatch(/close/i);
  });

  it("sends an expired session to sign in rather than asking it to retry", () => {
    const copy = requestFailureCopy(401, undefined, "");

    expect(copy.recovery).toBe("sign-in");
    expect(copy.title).toMatch(/sign(ed)? in|session/i);
  });
});

describe("zero generic messages", () => {
  it.each(EVERY_REASON)("has real copy for %s", (reason) => {
    // Exhaustive over the schema rather than over a list written here, so a reason added in
    // `packages/shared` fails this test instead of rendering an empty box.
    const copy = turnFailureCopy(reason, "detail from the server");

    expect(copy.title.length).toBeGreaterThan(0);
    expect(copy.action.length).toBeGreaterThan(0);
  });

  it.each(EVERY_REASON)("says something specific for %s", (reason) => {
    const copy = turnFailureCopy(reason, "");

    for (const phrase of GENERIC) {
      expect(copy.title).not.toMatch(phrase);
      expect(copy.action).not.toMatch(phrase);
    }
  });

  it("gives every reason a title of its own", () => {
    // Distinct states, per the task. Five reasons sharing three titles would satisfy every
    // assertion above and still leave the user unable to tell them apart.
    const titles = EVERY_REASON.map((reason) => turnFailureCopy(reason, "").title);

    expect(new Set(titles).size).toBe(EVERY_REASON.length);
  });

  it("does not pass the raw server string off as the whole explanation", () => {
    // The failure this guards against is copy that is just `message` — which for an internal
    // error is a stack-trace fragment, and for an empty message is nothing at all.
    for (const reason of EVERY_REASON) {
      expect(turnFailureCopy(reason, "raw").title).not.toBe("raw");
      expect(turnFailureCopy(reason, "").detail).not.toBe("");
    }
  });
});
