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
