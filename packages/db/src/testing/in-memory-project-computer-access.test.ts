import { expect, it } from "vitest";
import { enqueueRequest } from "./enqueue-request.ts";
import { InMemoryProjectComputerAccess } from "./in-memory-project-computer-access.ts";
import { InMemoryTurnQueue } from "./in-memory-turn-queue.ts";

it("shares durable-scope occupancy with every queued kind and leaves source leases per session", async () => {
  const queue = new InMemoryTurnQueue();
  const access = new InMemoryProjectComputerAccess(queue);
  const projectId = crypto.randomUUID(),
    sessionId = crypto.randomUUID(),
    siblingId = crypto.randomUUID(),
    userId = crypto.randomUUID();
  access.setProject({ projectId, userId, sessionIds: [sessionId, siblingId], sandboxId: "box" });
  const state = await access.read({ projectId, userId });
  if (!state.ok) throw new Error("Expected project.");
  const request = {
    projectId,
    sandboxId: "box",
    scopeId: crypto.randomUUID(),
    actor: {
      kind: "owner" as const,
      binding: {
        projectId,
        userId,
        sessionId,
        sandboxId: "box",
        revision: state.value.revision,
        expiresAt: Date.now() + 60_000,
      },
    },
  };
  expect((await access.reserve(request)).ok).toBe(true);
  for (const kind of ["turn", "resume", "publish", "test"] as const)
    await enqueueRequest(queue, {
      sessionId: siblingId,
      userId,
      kind,
      message: "build",
      model: "test",
      billsToUser: false,
    });
  expect(await queue.claim("blocked")).toBeNull();
  expect(
    await access.clear({
      ...request,
      proof: { protocol: 2, kind: "scope_drained", scopeId: request.scopeId, sandboxId: "box" },
    }),
  ).toBe(true);
  expect(await queue.claim("worker")).not.toBeNull();
  expect(await access.read({ projectId, userId })).toMatchObject({
    ok: false,
    error: { code: "busy" },
  });
});

it("abandons a stranded scope only after the window, without a lease, for its owner", async () => {
  let now = Date.parse("2026-10-25T00:00:00Z");
  const queue = new InMemoryTurnQueue();
  const access = new InMemoryProjectComputerAccess(queue, () => now);
  const projectId = crypto.randomUUID(),
    sessionId = crypto.randomUUID(),
    userId = crypto.randomUUID();
  access.setProject({ projectId, userId, sessionIds: [sessionId], sandboxId: "box" });
  const state = await access.read({ projectId, userId });
  if (!state.ok) throw new Error("Expected project.");
  const scope = { projectId, sandboxId: "box", scopeId: crypto.randomUUID() };
  await access.reserve({
    ...scope,
    actor: {
      kind: "owner",
      binding: {
        projectId,
        userId,
        sessionId,
        sandboxId: "box",
        revision: state.value.revision,
        expiresAt: now + 60_000,
      },
    },
  });
  expect(await access.held({ projectId, userId })).toMatchObject({
    ok: true,
    value: { reservation: { scopeId: scope.scopeId }, busy: false },
  });
  expect(await access.abandon({ ...scope, userId })).toEqual({
    ok: false,
    error: { code: "too_early" },
  });
  now += 5 * 60_000;
  expect(await access.abandon({ ...scope, userId: crypto.randomUUID() })).toEqual({
    ok: false,
    error: { code: "not_found" },
  });
  expect(await access.abandon({ ...scope, scopeId: crypto.randomUUID(), userId })).toEqual({
    ok: false,
    error: { code: "stale_grant" },
  });
  expect(await access.abandon({ ...scope, sandboxId: "other", userId })).toEqual({
    ok: false,
    error: { code: "stale_grant" },
  });
  expect(await access.abandon({ ...scope, userId })).toEqual({
    ok: true,
    value: { released: true },
  });
  expect(access.projects.get(projectId)).toMatchObject({ sandboxId: null });
  expect(access.projects.get(projectId)?.revision).not.toBe(state.value.revision);
  expect(await access.held({ projectId, userId })).toEqual({
    ok: true,
    value: { reservation: null, busy: false },
  });
});
