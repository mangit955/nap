import { InMemorySandboxManager } from "@nap/sandbox/testing/in-memory-sandbox-manager";
import type { AgentService, NativeAgentTurnRequest } from "@nap/shared/ports/agent-service";
import type { PendingEvent, StoredEvent } from "@nap/shared/ports/event-store";
import type { NativeTurnExecutor } from "@nap/shared/ports/native-turn-executor";
import { expect, it, vi } from "vitest";
import { NativeAgentService } from "./native-agent-service.ts";

const proof = {
  kind: "exit" as const,
  sequence: 3,
  code: 0,
  reason: "exited" as const,
  containment: "cgroup" as const,
};
function fixture() {
  const events: PendingEvent[] = [];
  const stored: StoredEvent[] = [];
  const finalize = vi.fn(async () => ({ commitSha: "verified-commit" }));
  const request: NativeAgentTurnRequest = {
    kind: "native",
    target: {
      kind: "subscription",
      driver: "claude",
      accountId: "00000000-0000-4000-8000-000000000001",
      generation: 3,
      model: "native-model",
    },
    userId: "owner",
    projectId: "project",
    sessionId: "session",
    turnId: "turn",
    sandboxId: "sandbox",
    input: { trustedInstructions: "Trusted Nap instructions", prompt: "Build the page" },
    lease: { requestId: "request", workerId: "worker" },
    sandbox: new InMemorySandboxManager(),
    onEvent: (event) => {
      events.push(event);
    },
    onStoredEvent: (event) => {
      stored.push(event);
    },
    drain: async () => {},
    finalize,
  };
  const api: AgentService = { runTurn: vi.fn(async () => {}) };
  return { request, events, stored, finalize, api };
}

it("runs the native target, publishes its durable output once and finalizes only after confirmed writer termination", async () => {
  const f = fixture();
  let stopped = false;
  const execute: NativeTurnExecutor = {
    run: async (input, options) => {
      expect(input).toMatchObject({
        input: { prompt: "Build the page" },
        target: f.request.target,
      });
      expect(input).not.toHaveProperty("context");
      expect(input).not.toHaveProperty("credentials");
      await options.publish({
        type: "agent.message",
        sessionId: "session",
        turnId: "turn",
        seq: 4,
        createdAt: "2026-10-24T00:00:00Z",
        payload: { text: "Built" },
      });
      expect(f.finalize).not.toHaveBeenCalled();
      stopped = true;
      return {
        kind: "completed",
        usage: null,
        usageIncomplete: true,
        quiescence: { kind: "confirmed", agent: proof, writers: [proof] },
      };
    },
  };
  await new NativeAgentService({ api: f.api, executor: execute }).runTurn(f.request);
  expect(stopped).toBe(true);
  expect(f.api.runTurn).not.toHaveBeenCalled();
  expect(f.stored).toHaveLength(1);
  expect(f.events.map((event) => event.type)).toEqual(["turn.started", "turn.completed"]);
  expect(f.events.at(-1)).toMatchObject({
    payload: { commitSha: "verified-commit", usageIncomplete: true },
  });
});

it("fences the workspace instead of finalizing on an unproven process-group receipt", async () => {
  const f = fixture();
  const executor: NativeTurnExecutor = {
    run: async () => ({
      kind: "completed",
      usage: null,
      usageIncomplete: true,
      quiescence: {
        kind: "confirmed",
        agent: { ...proof, containment: "process_group" },
        writers: [],
      },
    }),
  };
  expect(await new NativeAgentService({ api: f.api, executor }).runTurn(f.request)).toEqual({
    kind: "workspace_fenced",
  });
  expect(f.finalize).not.toHaveBeenCalled();
  expect(f.events.at(-1)?.type).toBe("turn.failed");
  expect(f.api.runTurn).not.toHaveBeenCalled();
});

it("refuses a native request without its worker authority or executor and never enters the API path", async () => {
  const f = fixture();
  await new NativeAgentService({ api: f.api }).runTurn(f.request);
  expect(f.finalize).not.toHaveBeenCalled();
  expect(f.api.runTurn).not.toHaveBeenCalled();
  expect(f.events.at(-1)).toMatchObject({
    type: "turn.failed",
    payload: { reason: "model_unavailable" },
  });
});
