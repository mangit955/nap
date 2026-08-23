/**
 * A job that a process restart left open, continued when its project is next opened.
 *
 * A restart is simulated by seeding the event store with the log a dead process would have
 * written and then calling `resumeSession` — which is exactly what the runtime sees, because a
 * job has no state anywhere but the log. The session is seeded with no sandbox, so every case
 * here also goes through a sandbox being created from nothing, which is the state a project
 * whose sandbox was destroyed comes back in.
 *
 * The expensive property is the one asserted most: **opening a project usually spends nothing.**
 * Every case below says whether a turn ran, and the ones that say no are the majority.
 */

import { completedTurn, ScriptedAgent } from "@nap/agent/testing/scripted-agent";
import { NoopMemoryProvider } from "@nap/context/noop-memory-provider";
import { StubContextEngine } from "@nap/context/testing/stub-context-engine";
import { InMemoryEventBus } from "@nap/db/testing/in-memory-event-bus";
import { InMemoryEventStore } from "@nap/db/testing/in-memory-event-store";
import { InMemorySessionStore } from "@nap/db/testing/in-memory-session-store";
import { TEMPLATE_DEV_PORT } from "@nap/sandbox/template";
import { InMemorySandboxManager } from "@nap/sandbox/testing/in-memory-sandbox-manager";
import { scriptGit } from "@nap/sandbox/testing/script-git";
import type { NapEvent, NapEventType, PromptSource } from "@nap/shared/events";
import { PROJECT_ROOT_PATH } from "@nap/shared/files-protocol";
import { foldJobs, MAX_REPAIR_ATTEMPTS } from "@nap/shared/job-state";
import type { PendingEvent, StoredEvent } from "@nap/shared/ports/event-store";
import { beforeEach, describe, expect, it } from "vitest";
import { SingleAgentRuntime } from "./single-agent-runtime.ts";

const SESSION_ID = "2a3f8a24-6c1b-4e0e-9b6f-3a5c0a1d9e77";
const PROJECT_ID = "4d5e6f70-1a2b-4c3d-8e9f-0a1b2c3d4e5f";
const JOB_ID = "3f9a1c2d-5e6b-4f7a-8b9c-0d1e2f3a4b5c";
const DEAD_TURN = "7c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f";
const COMMIT_SHA = "9e107d9d372bb6826bd81d3542a419d6c2b0f5a1";

/** One check, so a failure has exactly one cause and the assertions have one thing to watch. */
const MANIFEST = JSON.stringify({ scripts: { typecheck: "tsc --noEmit" } });

let sandbox: InMemorySandboxManager;
let events: InMemoryEventStore;
let sessions: InMemorySessionStore;
let agent: ScriptedAgent;

beforeEach(() => {
  sandbox = scriptGit(
    new InMemorySandboxManager({
      serves: [TEMPLATE_DEV_PORT],
      seed: { [`${PROJECT_ROOT_PATH}/package.json`]: MANIFEST },
    }),
  );
  events = new InMemoryEventStore();
  // No sandbox: the project was put away, or the process that held one died with it.
  sessions = new InMemorySessionStore([{ sessionId: SESSION_ID, projectId: PROJECT_ID }]);
  agent = new ScriptedAgent(() => completedTurn(COMMIT_SHA), true);
});

/** Writes the log a dead process would have left behind. */
async function seedLog(
  ...written: readonly { type: NapEvent["type"]; payload: unknown }[]
): Promise<void> {
  for (const event of written) {
    await events.append({
      ...event,
      sessionId: SESSION_ID,
      turnId: DEAD_TURN,
      createdAt: "2026-08-16T12:00:00.000Z",
    } as PendingEvent);
  }
}

const started = (objective = "add a delete button") => ({
  type: "job.started" as const,
  payload: { jobId: JOB_ID, objective },
});
const verifying = () => ({ type: "verification.started" as const, payload: { jobId: JOB_ID } });
const verified = (...checks: { name: string; outcome: string; output: string | null }[]) => ({
  type: "verification.completed" as const,
  payload: { jobId: JOB_ID, checks },
});
const committed = (commitSha: string | null) => ({
  type: "turn.completed" as const,
  payload: { usage: { inputTokens: 1, outputTokens: 1 }, durationMs: 1, commitSha },
});

const RED = { name: "typecheck", outcome: "failed", output: "src/App.tsx: error TS2304" };

/** One round of checks that said no — a repair turn's worth of history. */
const redRound = () => [verifying(), verified(RED)];

/** Typecheck says no, every time it is asked. */
function alwaysRed(): void {
  sandbox.script(/bun run typecheck/, { exitCode: 2, stderr: "src/App.tsx: error TS2304" });
}

/** Typecheck says yes, every time it is asked. */
function green(): void {
  sandbox.script(/bun run typecheck/, { exitCode: 0, stdout: "", stderr: "" });
}

/**
 * The turn id the resume request carries — the id of the row `POST /projects/:id/open` inserted.
 *
 * A resume is a queued request like any other, so its events are written under its own id and not
 * under the dead turn's. That is what makes the two distinguishable in the log at all.
 */
const RESUME_TURN = "b1e5c0de-2222-4333-8444-555566667777";

function open(turnId = RESUME_TURN) {
  return new SingleAgentRuntime({
    sessions,
    sandbox,
    context: new StubContextEngine(),
    agent,
    events,
    bus: new InMemoryEventBus(),
    memory: new NoopMemoryProvider(),
  }).resumeSession(SESSION_ID, { turnId });
}

async function log(): Promise<StoredEvent[]> {
  return await events.readFrom(SESSION_ID, 0);
}

/** Only what the open wrote — the seeded log is what the dead process left. */
async function written(): Promise<NapEventType[]> {
  return (await log()).filter((event) => event.turnId !== DEAD_TURN).map((event) => event.type);
}

async function jobs() {
  return foldJobs(await log());
}

async function promptSources(): Promise<PromptSource[]> {
  return (await log()).flatMap((event) =>
    event.type === "turn.started" ? [event.payload.source] : [],
  );
}

const countOf = (types: NapEventType[], type: NapEventType) =>
  types.filter((seen) => seen === type).length;

describe("an open with no job to continue", () => {
  it("spends nothing on a session that has never had one", async () => {
    const outcome = await open();

    expect(outcome.ok).toBe(true);
    expect(agent.calls).toBe(0);
    expect(await written()).not.toContain("verification.started");
  });

  it("spends nothing on a job whose checks already came back green", async () => {
    await seedLog(started(), committed(COMMIT_SHA), verifying(), verified());
    green();

    await open();

    expect(agent.calls).toBe(0);
    expect(await written()).not.toContain("verification.started");
  });
});

describe("a job whose turn died before it committed", () => {
  it("closes it rather than leaving it open or calling a model", async () => {
    await seedLog(started());

    await open();

    expect(agent.calls).toBe(0);
    const state = await jobs();
    expect(state.jobs.at(-1)?.phase).toBe("unverified");
  });

  it("opens no second job for it, however many times the project is opened", async () => {
    // The at-most-once execution guarantee, seen from the log. Delivery may be at-least-once and
    // a human may click open as often as they like; what must never happen is the same objective
    // becoming two jobs, which is two verification budgets and two of somebody's commits under
    // one request. Nothing requeues the dead request, and a continuation folds the log and asks
    // what the *job* still needs rather than re-running anything.
    await seedLog(started(), { type: "turn.started", payload: { source: "user" } });

    await open();
    await open("d2f0a1b2-3333-4444-8555-666677778888");

    const types = (await log()).map((event) => event.type);
    expect(countOf(types, "job.started")).toBe(1);
    expect(countOf(types, "turn.started")).toBe(1);
    expect(agent.calls).toBe(0);
    // And what the first open wrote is attributable to the request that asked for it, rather
    // than to the turn that died — which is how the two are told apart at all.
    const closing = (await log()).filter((event) => event.type === "job.completed");
    expect(closing.map((event) => event.turnId)).toEqual([RESUME_TURN]);
  });
});

describe("a job whose turn committed and was never checked", () => {
  it("runs the checks and checkpoints the commit the restart left behind", async () => {
    await seedLog(started(), committed(COMMIT_SHA));
    green();

    await open();

    // No repair: the checks answered the question the job existed to ask.
    expect(agent.calls).toBe(0);
    expect(await written()).toContain("verification.started");
    const state = await jobs();
    expect(state.jobs.at(-1)?.phase).toBe("verified");
    expect(state.checkpointSha).toBe(COMMIT_SHA);
  });

  it("finishes an interrupted round without beginning a second one", async () => {
    // `verification.started` is already in the log; the answer is not. A second one would
    // count as a repair attempt that no repair turn ever used.
    await seedLog(started(), committed(COMMIT_SHA), verifying());
    green();

    await open();

    expect(countOf(await written(), "verification.started")).toBe(0);
    const state = await jobs();
    expect(state.jobs.at(-1)?.phase).toBe("verified");
    expect(state.jobs.at(-1)?.attemptsUsed).toBe(0);
  });
});

describe("a job left in repair", () => {
  it("runs the repair the crash interrupted, prompted by the verifier", async () => {
    await seedLog(started(), committed(COMMIT_SHA), ...redRound());
    green();

    await open();

    expect(agent.calls).toBe(1);
    expect(await promptSources()).toEqual(["verification"]);
    expect((await jobs()).jobs.at(-1)?.phase).toBe("verified");
  });

  it("repairs from the recorded failure rather than running the checks again first", async () => {
    // The commit has not moved, so re-asking would learn the same thing — and `foldJobs`
    // counts attempts from verification rounds, so it would silently spend one.
    await seedLog(started(), committed(COMMIT_SHA), ...redRound());
    green();

    await open();

    const types = await written();
    expect(types.indexOf("user.message")).toBeLessThan(types.indexOf("verification.started"));
  });

  it("keeps the attempts already spent instead of restarting the budget", async () => {
    // Two rounds are already in the log, so one repair has run. An always-red project may
    // therefore have exactly two more turns before the job is exhausted.
    await seedLog(
      started(),
      committed(COMMIT_SHA),
      ...redRound(),
      committed(COMMIT_SHA),
      ...redRound(),
    );
    alwaysRed();

    await open();

    expect(agent.calls).toBe(MAX_REPAIR_ATTEMPTS - 1);
    const job = (await jobs()).jobs.at(-1);
    expect(job?.phase).toBe("exhausted");
    expect(job?.attemptsUsed).toBe(MAX_REPAIR_ATTEMPTS);
  });

  it("carries the job's objective into the turn it continues with", async () => {
    await seedLog(started("add a delete button"), committed(COMMIT_SHA), ...redRound());
    green();

    await open();

    expect((await jobs()).jobs.at(-1)?.objective).toBe("add a delete button");
  });
});

describe("a continuation that falls over", () => {
  it("still reports the project as open, and closes the job behind it", async () => {
    // The project is up and usable either way, and a job left open here is one that the *next*
    // open would try to continue too — with nothing about the failure changed by then.
    await seedLog(started(), committed(COMMIT_SHA), ...redRound());
    agent.before = async () => {
      throw new Error("the model provider fell over");
    };

    const outcome = await open();

    expect(outcome).toMatchObject({ ok: true });
    expect((await jobs()).jobs.at(-1)?.phase).toBe("abandoned");
  });
});

describe("continuing on a sandbox that had to be restored", () => {
  it("reports the resume as having created one, and continues anyway", async () => {
    await seedLog(started(), committed(COMMIT_SHA), ...redRound());
    green();

    const outcome = await open();

    expect(outcome).toMatchObject({ ok: true, created: true });
    expect(agent.calls).toBe(1);
  });
});
