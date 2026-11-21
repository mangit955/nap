/**
 * A message sent to a session whose last job a dead worker left open.
 *
 * The worker's death is simulated the way `continue-on-open.test.ts` simulates a restart: by
 * seeding the log with what the dead worker wrote and what the janitor wrote after it, because a
 * job has no state anywhere but the log. Then a message is sent instead of pressing Resume.
 *
 * The property under test: **the interrupted job never stays open under a newer one.** A message
 * opens its own job, and `openJob` only ever looks at the newest, so an older job still open at
 * that moment would be closed by nothing and its last commit never checked. Where the log already
 * holds the job's answer it closes as that answer; where finishing it would cost work, the message
 * supersedes it, and the log says so.
 */

import { completedTurn, ScriptedAgent } from "@nap/agent/testing/scripted-agent";
import { NoopMemoryProvider } from "@nap/context/noop-memory-provider";
import { StubContextEngine } from "@nap/context/testing/stub-context-engine";
import { InMemoryEventBus } from "@nap/db/testing/in-memory-event-bus";
import { InMemoryEventStore } from "@nap/db/testing/in-memory-event-store";
import { InMemorySessionStore } from "@nap/db/testing/in-memory-session-store";
import { TEMPLATE_DEV_PORT } from "@nap/sandbox/template";
import { InMemorySandboxManager } from "@nap/sandbox/testing/in-memory-sandbox-manager";
import { FAKE_COMMIT_SHA, scriptGit } from "@nap/sandbox/testing/script-git";
import type { NapEvent } from "@nap/shared/events";
import { PROJECT_ROOT_PATH } from "@nap/shared/files-protocol";
import { foldJobs } from "@nap/shared/job-state";
import type { PendingEvent, StoredEvent } from "@nap/shared/ports/event-store";
import { beforeEach, describe, expect, it } from "vitest";
import { SingleAgentRuntime } from "./single-agent-runtime.ts";

const SESSION_ID = "2a3f8a24-6c1b-4e0e-9b6f-3a5c0a1d9e77";
const PROJECT_ID = "4d5e6f70-1a2b-4c3d-8e9f-0a1b2c3d4e5f";
const OLD_JOB = "3f9a1c2d-5e6b-4f7a-8b9c-0d1e2f3a4b5c";
const EARLIER_JOB = "8c7b6a59-4d3e-4f21-9a8b-7c6d5e4f3a2b";
const DEAD_TURN = "7c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f";
const MESSAGE_TURN = "b1e5c0de-2222-4333-8444-555566667777";
/** `scriptGit`'s own sha, so the workspace is sitting on the commit the dead turn announced. */
const COMMIT_SHA = FAKE_COMMIT_SHA;

const MANIFEST = JSON.stringify({ scripts: { typecheck: "tsc --noEmit" } });

let sandbox: InMemorySandboxManager;
let events: InMemoryEventStore;
let agent: ScriptedAgent;

beforeEach(() => {
  sandbox = scriptGit(
    new InMemorySandboxManager({
      serves: [TEMPLATE_DEV_PORT],
      seed: { [`${PROJECT_ROOT_PATH}/package.json`]: MANIFEST },
    }),
  );
  sandbox.script(/bun run typecheck/, { exitCode: 0, stdout: "", stderr: "" });
  events = new InMemoryEventStore();
  agent = new ScriptedAgent(() => completedTurn(COMMIT_SHA), true);
});

/** The dead worker's events, then the janitor's: the log a message arrives on. */
async function seedLog(
  ...written: readonly { type: NapEvent["type"]; payload: unknown }[]
): Promise<void> {
  const janitor = [
    {
      type: "turn.failed",
      payload: { reason: "internal", message: "This turn was interrupted." },
    },
    { type: "system.notice", payload: { level: "warning", text: "Nothing was lost." } },
  ] as const;
  for (const event of [...written, ...janitor]) {
    await events.append({
      ...event,
      sessionId: SESSION_ID,
      turnId: DEAD_TURN,
      createdAt: "2026-11-21T12:00:00.000Z",
    } as PendingEvent);
  }
}

const started = (jobId = OLD_JOB) => ({
  type: "job.started" as const,
  payload: { jobId, objective: "add a delete button" },
});
const turnStarted = () => ({ type: "turn.started" as const, payload: { source: "user" } });
const committed = (commitSha: string | null) => ({
  type: "turn.completed" as const,
  payload: { usage: { inputTokens: 1, outputTokens: 1 }, durationMs: 1, commitSha },
});
const verifying = () => ({ type: "verification.started" as const, payload: { jobId: OLD_JOB } });
const red = () => ({
  type: "verification.completed" as const,
  payload: {
    jobId: OLD_JOB,
    checks: [{ name: "typecheck", outcome: "failed", output: "src/App.tsx: error TS2304" }],
  },
});
const checkpointed = (jobId = OLD_JOB) => ({
  type: "job.checkpointed" as const,
  payload: { jobId, commitSha: COMMIT_SHA },
});
const green = (jobId = OLD_JOB) => ({
  type: "verification.completed" as const,
  payload: { jobId, checks: [{ name: "typecheck", outcome: "passed", output: null }] },
});
const closed = (jobId: string) => ({
  type: "job.completed" as const,
  payload: { jobId, outcome: "verified" },
});

function runtime(): SingleAgentRuntime {
  return new SingleAgentRuntime({
    // The sandbox outlived the worker, which is the usual case: a dead process, a live project.
    sessions: new InMemorySessionStore([{ sessionId: SESSION_ID, projectId: PROJECT_ID }]),
    sandbox,
    context: new StubContextEngine(),
    agent,
    events,
    bus: new InMemoryEventBus(),
    memory: new NoopMemoryProvider(),
  });
}

async function send(message = "make the header sticky", signal?: AbortSignal) {
  return await runtime().runTurn({
    sessionId: SESSION_ID,
    turnId: MESSAGE_TURN,
    message,
    ...(signal === undefined ? {} : { signal }),
  });
}

async function log(): Promise<StoredEvent[]> {
  return await events.readFrom(SESSION_ID, 0);
}

async function oldJob() {
  return foldJobs(await log()).jobs.find((job) => job.jobId === OLD_JOB);
}

/** What the message's turn wrote about the old job, in order. */
async function closingOfOldJob(): Promise<StoredEvent[]> {
  return (await log()).filter(
    (event) =>
      event.turnId === MESSAGE_TURN &&
      ((event.type === "job.completed" && event.payload.jobId === OLD_JOB) ||
        event.type === "system.notice"),
  );
}

describe("a message on a session whose job was interrupted with an unchecked commit", () => {
  beforeEach(async () => {
    await seedLog(started(), turnStarted(), committed(COMMIT_SHA));
  });

  it("closes the interrupted job as superseded rather than leaving it open", async () => {
    const outcome = await send();

    expect(outcome.ok).toBe(true);
    expect((await oldJob())?.phase).toBe("superseded");
  });

  it("says so in the log, under the message's own turn, before the new job opens", async () => {
    await send();

    const types = (await log())
      .filter((event) => event.turnId === MESSAGE_TURN)
      .map((event) => event.type);
    const closedAt = types.indexOf("job.completed");
    expect(closedAt).toBeGreaterThan(types.indexOf("user.message"));
    // The notice too: it explains the close, and belongs before the work that replaces the job.
    expect(types.indexOf("system.notice")).toBe(closedAt + 1);
    expect(closedAt + 1).toBeLessThan(types.indexOf("job.started"));

    const closing = await closingOfOldJob();
    expect(closing.map((event) => event.type)).toEqual(["job.completed", "system.notice"]);
    expect(closing[0]?.payload).toEqual({ jobId: OLD_JOB, outcome: "superseded" });
    expect(closing[1]?.payload).toMatchObject({ level: "info" });
  });

  it("runs the message and nothing of the old job: one model call, one new job", async () => {
    await send();

    expect(agent.calls).toBe(1);
    const state = foldJobs(await log());
    expect(state.jobs.map((job) => job.phase)).toEqual(["superseded", "verified"]);
  });

  it("leaves it open for Resume when the message is stopped before its work starts", async () => {
    // Stopped while the runtime asks the workspace what it is sitting on: after the sandbox is in
    // hand, before anything has replaced the old job.
    const stop = new AbortController();
    sandbox.script(/git rev-parse HEAD/, () => {
      stop.abort();
      return { exitCode: 0, stdout: `${COMMIT_SHA}\n`, stderr: "" };
    });

    const outcome = await send("make the header sticky", stop.signal);

    expect(outcome).toMatchObject({ ok: false, reason: "cancelled" });
    expect(agent.calls).toBe(0);
    expect((await oldJob())?.phase).toBe("working");
    expect(foldJobs(await log()).jobs).toHaveLength(1);
  });
});

describe("a message on a session whose job was interrupted mid-repair", () => {
  it("supersedes it without running the repair the crash interrupted", async () => {
    await seedLog(started(), turnStarted(), committed(COMMIT_SHA), verifying(), red());

    await send();

    expect(agent.calls).toBe(1);
    expect((await oldJob())?.phase).toBe("superseded");
    const sources = (await log()).flatMap((event) =>
      event.type === "turn.started" && event.turnId !== DEAD_TURN ? [event.payload.source] : [],
    );
    expect(sources).toEqual(["user"]);
  });
});

describe("a message on a session whose interrupted job the log already answers", () => {
  it("closes it unverified, with no notice, when it died before committing anything", async () => {
    // An earlier job left the project at a checkpoint; the interrupted one never moved HEAD off
    // it. Nothing is unchecked, so there is nothing to supersede: continuing would say the same.
    await seedLog(
      started(EARLIER_JOB),
      committed(COMMIT_SHA),
      green(EARLIER_JOB),
      checkpointed(EARLIER_JOB),
      closed(EARLIER_JOB),
      started(),
      turnStarted(),
    );

    await send();

    expect((await oldJob())?.phase).toBe("unverified");
    const closing = await closingOfOldJob();
    expect(closing.map((event) => event.type)).toEqual(["job.completed"]);
  });
});

describe("a turn that opens no job", () => {
  it("leaves the interrupted job open for Resume when the turn only proposes a plan", async () => {
    await seedLog(started(), turnStarted(), committed(COMMIT_SHA));

    await runtime().runTurn({
      sessionId: SESSION_ID,
      turnId: MESSAGE_TURN,
      message: "plan a dark theme",
      plan: { intent: "propose" },
    });

    expect((await oldJob())?.phase).toBe("working");
    expect(await closingOfOldJob()).toEqual([]);
  });
});
