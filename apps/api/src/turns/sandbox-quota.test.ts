/**
 * Two ceilings, and one exemption that carries most of the design.
 *
 * The exemption is the interesting case: a turn in a project that already has a sandbox creates
 * nothing, so refusing it would turn "sandboxes you may run" into "projects you may talk to" —
 * a user at their cap could not continue the conversation they are already in.
 */

import { FAKE_OWNER, InMemoryProjectStore } from "@nap/db/testing/in-memory-project-store";
import type { ProjectSummary } from "@nap/shared/ports/project-store";
import { describe, expect, it } from "vitest";
import { checkSandboxQuota } from "./sandbox-quota.ts";

const STRANGER = "00000000-0000-4000-8000-0000000000ff";
const LIMITS = { perUser: 2, total: 3 };

function project(id: string, sandboxId: string | null, userId = FAKE_OWNER) {
  return {
    projectId: id,
    name: id,
    status: sandboxId === null ? "idle" : "ready",
    sandboxId,
    updatedAt: "2026-08-10T11:00:00.000Z",
    sessionIds: [],
    userId,
  } satisfies ProjectSummary & { userId: string };
}

/** `running` describes what is already live; the caller's own session has no sandbox by default. */
function check(running: ReturnType<typeof project>[], sessionSandboxId: string | null = null) {
  return checkSandboxQuota({
    projects: new InMemoryProjectStore(running),
    userId: FAKE_OWNER,
    sessionSandboxId,
    limits: LIMITS,
  });
}

describe("under the cap", () => {
  it("allows a turn when the user has none running", async () => {
    await expect(check([])).resolves.toEqual({ allowed: true });
  });

  it("allows one that takes them up to the cap", async () => {
    await expect(check([project("a", "sbx-a")])).resolves.toEqual({ allowed: true });
  });
});

describe("at the cap", () => {
  it("refuses a turn that would need a new sandbox", async () => {
    const decision = await check([project("a", "sbx-a"), project("b", "sbx-b")]);

    expect(decision).toMatchObject({ allowed: false, reason: "per_user" });
  });

  it("still allows a turn in a project that already has one", async () => {
    // The exemption. This turn resumes `sbx-a` and creates nothing, so the count does not move
    // — and without this, being at the cap would silently freeze every conversation you have.
    const running = [project("a", "sbx-a"), project("b", "sbx-b")];

    await expect(check(running, "sbx-a")).resolves.toEqual({ allowed: true });
  });

  it("does not count projects that are put away", async () => {
    // An idle project holds no sandbox, so it costs nothing and must not consume a slot.
    const running = [project("a", "sbx-a"), project("b", null), project("c", null)];

    await expect(check(running)).resolves.toEqual({ allowed: true });
  });
});

describe("the cluster-wide ceiling", () => {
  it("refuses a user who is under their own cap but the deployment is full", async () => {
    // Beyond what the task asks for, and the number that bounds the total bill: per-user limits
    // alone mean N strangers cost N times the cap. Refusing here is the cheap answer; the one
    // that actually holds is taken when the sandbox is created.
    const running = [
      project("a", "sbx-a", STRANGER),
      project("b", "sbx-b", STRANGER),
      project("c", "sbx-c", STRANGER),
    ];

    const decision = await check(running);

    expect(decision).toMatchObject({ allowed: false, reason: "total" });
  });

  it("names the per-user reason first when both ceilings are reached", async () => {
    // What the user can act on. "Close one of your projects" is useful; "the server is busy"
    // is not, when the projects filling it are their own.
    const running = [project("a", "sbx-a"), project("b", "sbx-b"), project("c", "sbx-c", STRANGER)];

    await expect(check(running)).resolves.toMatchObject({ reason: "per_user" });
  });
});

describe("limits are per user, not global", () => {
  it("does not count another user's sandboxes against this one", async () => {
    // The isolation claim, at the quota rather than at the rate limit. A count that forgot its
    // `where` clause would refuse the second person to arrive.
    const running = [project("a", "sbx-a", STRANGER), project("b", "sbx-b", STRANGER)];

    await expect(check(running)).resolves.toEqual({ allowed: true });
  });
});
