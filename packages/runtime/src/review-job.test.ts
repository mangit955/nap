import { completedTurn, ScriptedAgent } from "@nap/agent/testing/scripted-agent";
import { NoopMemoryProvider } from "@nap/context/noop-memory-provider";
import { StubContextEngine } from "@nap/context/testing/stub-context-engine";
import { InMemoryEventBus } from "@nap/db/testing/in-memory-event-bus";
import { InMemoryEventStore } from "@nap/db/testing/in-memory-event-store";
import { InMemorySessionStore } from "@nap/db/testing/in-memory-session-store";
import { InMemorySnapshotStore } from "@nap/db/testing/in-memory-snapshot-store";
import { TEMPLATE_DEV_PORT } from "@nap/sandbox/template";
import { InMemorySandboxManager } from "@nap/sandbox/testing/in-memory-sandbox-manager";
import { FAKE_COMMIT_SHA, scriptGit } from "@nap/sandbox/testing/script-git";
import { foldJobs, MAX_REPAIR_ATTEMPTS } from "@nap/shared/job-state";
import type { RepositorySource, RepositoryWorkspace } from "@nap/shared/ports/repository-workspace";
import { MAX_REVIEW_ROUNDS, type Reviewer, type ReviewResult } from "@nap/shared/ports/reviewer";
import { InMemoryObjectStore } from "@nap/storage/testing/in-memory-object-store";
import { describe, expect, it, vi } from "vitest";
import { SingleAgentRuntime } from "./single-agent-runtime.ts";

const sessionId = "2a3f8a24-6c1b-4e0e-9b6f-3a5c0a1d9e77";
const projectId = "4d5e6f70-1a2b-4c3d-8e9f-0a1b2c3d4e5f";
const source: RepositorySource = {
  setupCommand: null,
  devCommand: null,
  previewPort: null,
  initialBundle: async () => ({ ok: true, value: Buffer.from("bundle") }),
};

const USAGE = { inputTokens: 10, outputTokens: 1 };
const PASS: ReviewResult = {
  status: "completed",
  blocking: [],
  notes: [{ summary: "naming could be clearer", command: null, observed: null }],
  failure: null,
  steps: 2,
  usage: USAGE,
};
const BLOCK: ReviewResult = {
  status: "completed",
  blocking: [{ summary: "parse returns 2", command: "pytest -q", observed: "expected 3, got 2" }],
  notes: [],
  failure: null,
  steps: 3,
  usage: USAGE,
};

async function fixture(options: { results: ReviewResult[]; repository?: boolean }) {
  const sandbox = scriptGit(
    new InMemorySandboxManager({
      seed: { "/home/user/app/package.json": '{"scripts":{"typecheck":"tsc --noEmit"}}' },
    }),
  );
  const created = await sandbox.create(projectId);
  if (!created.ok) throw new Error(created.error.message);
  sandbox.script(/bun run typecheck/, { exitCode: 0 });
  const sessions = new InMemorySessionStore([
    { sessionId, projectId, sandboxId: created.value.id },
  ]);
  const events = new InMemoryEventStore();
  const finishJob = vi.fn<RepositoryWorkspace["finishJob"]>(async () => ({
    ok: true,
    value: undefined,
  }));
  const repository: RepositoryWorkspace = {
    source: async () => ({ ok: true, value: source }),
    prepareJob: async () => ({ ok: true, value: undefined }),
    finishJob,
  };
  const queue = [...options.results];
  const review = vi.fn<Reviewer["review"]>(async () => queue.shift() ?? PASS);
  const agent = new ScriptedAgent(() => completedTurn(FAKE_COMMIT_SHA), true);
  const context = new StubContextEngine();
  const runtime = new SingleAgentRuntime({
    sessions,
    sandbox,
    events,
    objects: new InMemoryObjectStore(),
    snapshots: new InMemorySnapshotStore(),
    ...(options.repository === false ? {} : { repository }),
    agent,
    context,
    reviewer: { review },
    bus: new InMemoryEventBus(),
    memory: new NoopMemoryProvider(),
  });
  const run = () =>
    runtime.runTurn({
      sessionId,
      turnId: crypto.randomUUID(),
      message: "Make parse return 3",
      model: "openai/gpt-6-luna",
      credentials: { platform: "openrouter", apiKey: "person's key" },
    });
  return { sandbox, sandboxId: created.value.id, events, finishJob, review, agent, context, run };
}

describe("the review in an imported repository's job", () => {
  it("runs after the checks pass, on the turn's model and account, and records its notes", async () => {
    const f = await fixture({ results: [PASS] });
    expect(await f.run()).toMatchObject({ ok: true });

    expect(f.review).toHaveBeenCalledOnce();
    expect(f.review.mock.calls[0]?.[0]).toMatchObject({
      objective: "Make parse return 3",
      model: "openai/gpt-6-luna",
      credentials: { platform: "openrouter", apiKey: "person's key" },
    });
    const events = await f.events.readFrom(sessionId, 0);
    const verification = events.find((event) => event.type === "verification.completed");
    expect(verification?.payload.checks.at(-1)).toEqual({
      name: "review",
      outcome: "passed",
      output: "- naming could be clearer",
    });
    expect(foldJobs(events).jobs.at(-1)?.phase).toBe("verified");
    expect(f.finishJob).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ outcome: "verified" }),
    );
  });

  it("sends the agent back with what it proved, then publishes once a review passes", async () => {
    const f = await fixture({ results: [BLOCK, PASS] });
    expect(await f.run()).toMatchObject({ ok: true });

    expect(f.agent.calls).toBe(2);
    expect(f.review).toHaveBeenCalledTimes(2);
    const repair = f.context.requests[1];
    expect(repair?.userMessage).toContain("A reviewer checked your work");
    expect(repair?.userMessage).toContain("expected 3, got 2");
    expect(repair?.job?.attempts.map((attempt) => attempt.check)).toEqual(["review"]);
    const events = await f.events.readFrom(sessionId, 0);
    const outcomes = events
      .filter((event) => event.type === "verification.completed")
      .map((event) => event.payload.checks.find((check) => check.name === "review")?.outcome);
    expect(outcomes).toEqual(["failed", "passed"]);
    expect(f.finishJob).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ outcome: "verified" }),
    );
  });

  it(`runs at most ${MAX_REVIEW_ROUNDS} reviews, then lets the checks alone decide`, async () => {
    const f = await fixture({ results: [BLOCK, BLOCK, BLOCK, BLOCK] });
    expect(await f.run()).toMatchObject({ ok: true });

    expect(f.review).toHaveBeenCalledTimes(MAX_REVIEW_ROUNDS);
    expect(f.agent.calls).toBe(MAX_REVIEW_ROUNDS + 1);
    expect(MAX_REVIEW_ROUNDS).toBeLessThan(MAX_REPAIR_ATTEMPTS);
    const events = await f.events.readFrom(sessionId, 0);
    expect(foldJobs(events).jobs.at(-1)?.phase).toBe("verified");
  });

  it("is not run when the checks fail: the failed check is the repair", async () => {
    const f = await fixture({ results: [] });
    let failures = 1;
    f.sandbox.script(/bun run typecheck/, () =>
      failures-- > 0 ? { exitCode: 1, stderr: "TS2322" } : { exitCode: 0 },
    );
    expect(await f.run()).toMatchObject({ ok: true });
    expect(f.agent.calls).toBe(2);
    expect(f.review).toHaveBeenCalledOnce();
  });

  it("is not run when no repair is left to send the job back to", async () => {
    const f = await fixture({ results: [BLOCK] });
    let failures = MAX_REPAIR_ATTEMPTS;
    f.sandbox.script(/bun run typecheck/, () =>
      failures-- > 0 ? { exitCode: 1, stderr: "TS2322" } : { exitCode: 0 },
    );
    expect(await f.run()).toMatchObject({ ok: true });
    expect(f.review).not.toHaveBeenCalled();
    expect(f.finishJob).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ outcome: "verified" }),
    );
  });

  it("blocks nothing when it throws", async () => {
    const f = await fixture({ results: [] });
    f.review.mockRejectedValue(new Error("provider down"));
    expect(await f.run()).toMatchObject({ ok: true });
    expect(f.agent.calls).toBe(1);
    const events = await f.events.readFrom(sessionId, 0);
    const verification = events.find((event) => event.type === "verification.completed");
    expect(verification?.payload.checks.some((check) => check.name === "review")).toBe(false);
    expect(foldJobs(events).jobs.at(-1)?.phase).toBe("verified");
  });

  it("puts back anything a reviewer's command left in the workspace", async () => {
    const f = await fixture({ results: [PASS] });
    let reviewing = false;
    f.review.mockImplementation(async () => {
      reviewing = true;
      return PASS;
    });
    f.sandbox.script(/git rev-parse HEAD && git --no-optional-locks status/, () => ({
      exitCode: 0,
      stdout: reviewing ? `${FAKE_COMMIT_SHA}\n?? .pytest_cache/\n` : `${FAKE_COMMIT_SHA}\n`,
    }));
    f.sandbox.script(/git reset --quiet --hard/, { exitCode: 0 });
    expect(await f.run()).toMatchObject({ ok: true });
    expect(f.sandbox.commands(f.sandboxId)).toContain(
      `cd /home/user/app && git reset --quiet --hard '${FAKE_COMMIT_SHA}' && git clean -fdq`,
    );
  });

  it("is not run for a Nap project, which publishes no pull request", async () => {
    const f = await fixture({ results: [BLOCK], repository: false });
    f.sandbox.listen(f.sandboxId, TEMPLATE_DEV_PORT);
    expect(await f.run()).toMatchObject({ ok: true });
    expect(f.review).not.toHaveBeenCalled();
    expect(f.agent.calls).toBe(1);
    // Arbitrated, so the review was skipped rather than never reached.
    const events = await f.events.readFrom(sessionId, 0);
    expect(foldJobs(events).jobs.at(-1)?.phase).toBe("verified");
  });
});
