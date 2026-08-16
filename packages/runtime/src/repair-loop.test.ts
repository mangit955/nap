/**
 * The repair turn, and the bound on how many of them there can be.
 *
 * A repair is a Turn whose prompt came from the verifier (`docs/adr/0006`), so most of what is
 * asserted here is that it is *ordinary*: it opens with a `turn.started`, it commits, it is
 * verified, and it belongs to the job that was already open. What is not ordinary about it is
 * the one field that says who prompted it, and the three attempts it is allowed.
 *
 * The agent is scripted, so what a repair turn *achieves* is set by the test rather than by a
 * model: a sandbox whose typecheck starts failing and is scripted green partway through is a
 * repair that worked, and one that never turns green is a job that runs out of attempts.
 * Nothing here asserts on prose the model produced — the only prose asserted on is the prompt
 * this package writes, and that is `repair-prompt.test.ts`'s.
 */

import { type AgentScript, completedTurn, ScriptedAgent } from "@nap/agent/testing/scripted-agent";
import { NoopMemoryProvider } from "@nap/context/noop-memory-provider";
import { StubContextEngine } from "@nap/context/testing/stub-context-engine";
import { InMemoryEventBus } from "@nap/db/testing/in-memory-event-bus";
import { InMemoryEventStore } from "@nap/db/testing/in-memory-event-store";
import { InMemorySessionStore } from "@nap/db/testing/in-memory-session-store";
import { TEMPLATE_DEV_PORT } from "@nap/sandbox/template";
import { InMemorySandboxManager } from "@nap/sandbox/testing/in-memory-sandbox-manager";
import { scriptGit } from "@nap/sandbox/testing/script-git";
import type { NapEventType, PromptSource } from "@nap/shared/events";
import { PROJECT_ROOT_PATH } from "@nap/shared/files-protocol";
import { foldJobs, MAX_REPAIR_ATTEMPTS } from "@nap/shared/job-state";
import type { StoredEvent } from "@nap/shared/ports/event-store";
import { beforeEach, describe, expect, it } from "vitest";
import { SingleAgentRuntime } from "./single-agent-runtime.ts";

const SESSION_ID = "2a3f8a24-6c1b-4e0e-9b6f-3a5c0a1d9e77";
const PROJECT_ID = "4d5e6f70-1a2b-4c3d-8e9f-0a1b2c3d4e5f";
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
  sessions = new InMemorySessionStore([{ sessionId: SESSION_ID, projectId: PROJECT_ID }]);
  agent = new ScriptedAgent(() => completedTurn(COMMIT_SHA), true);
});

/** Typecheck says no, every time it is asked. */
function alwaysRed(): void {
  sandbox.script(/bun run typecheck/, { exitCode: 2, stderr: "src/App.tsx: error TS2304" });
}

/**
 * Typecheck says no until the nth time it is asked, then yes.
 *
 * The only way to script a repair that worked: the agent is a fixture and cannot fix anything,
 * so the project is what changes its mind.
 */
function redUntil(attempt: number): void {
  let asked = 0;
  sandbox.script(/bun run typecheck/, () => {
    asked += 1;
    return asked >= attempt
      ? { exitCode: 0, stdout: "", stderr: "" }
      : { exitCode: 2, stdout: "", stderr: "src/App.tsx: error TS2304" };
  });
}

function run(options: { signal?: AbortSignal } = {}) {
  return new SingleAgentRuntime({
    sessions,
    sandbox,
    context: new StubContextEngine(),
    agent,
    events,
    bus: new InMemoryEventBus(),
    memory: new NoopMemoryProvider(),
  }).runTurn({
    sessionId: SESSION_ID,
    message: "add a delete button",
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
}

async function log(): Promise<StoredEvent[]> {
  return await events.readFrom(SESSION_ID, 0);
}

async function loggedTypes(): Promise<NapEventType[]> {
  return (await log()).map((event) => event.type);
}

async function jobs() {
  return foldJobs(await log());
}

/** Who prompted each turn, in order — the log's own answer to "which of these were repairs". */
async function promptSources(): Promise<PromptSource[]> {
  return (await log()).flatMap((event) =>
    event.type === "turn.started" ? [event.payload.source] : [],
  );
}

const countOf = (types: NapEventType[], type: NapEventType) =>
  types.filter((seen) => seen === type).length;

describe("a check that says no", () => {
  it("prompts another turn on the same job, marked as the verifier's", async () => {
    redUntil(2);

    await run();

    expect(await promptSources()).toEqual(["user", "verification"]);
    // One job, spanning both turns. A repair that opened its own job would be a second
    // objective in the log and a fresh set of attempts.
    const state = await jobs();
    expect(state.jobs).toHaveLength(1);
    expect(state.jobs[0]?.phase).toBe("verified");
  });

  it("carries the failure into the turn that has to fix it", async () => {
    redUntil(2);

    await run();

    // The prompt the verifier wrote, as the log recorded it — the second `user.message`, since
    // a repair's prompt is a prompt like any other and travels the same way.
    const prompts = (await log()).flatMap((event) =>
      event.type === "user.message" ? [event.payload.text] : [],
    );

    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("typecheck");
    expect(prompts[1]).toContain("src/App.tsx: error TS2304");
  });

  it("is an ordinary turn: it commits, and its commit is verified in its own right", async () => {
    redUntil(2);

    await run();

    expect(await loggedTypes()).toEqual([
      "user.message",
      "job.started",
      "preview.ready",
      "turn.started",
      "turn.completed",
      "verification.started",
      "verification.completed",
      // Red. No checkpoint, no `job.completed` — the job stays open and the verifier prompts.
      "user.message",
      "turn.started",
      "turn.completed",
      "verification.started",
      "verification.completed",
      "job.checkpointed",
      "job.completed",
    ]);
  });

  it("runs each repair under a turn id of its own", async () => {
    // Two turns sharing one id would collapse into one turn for every reader of the log —
    // the transcript, the metrics, and anything reconstructing a turn from log lines.
    redUntil(2);

    await run();

    const turnIds = new Set((await log()).map((event) => event.turnId));
    expect(turnIds.size).toBe(2);
    expect(agent.requests.map((request) => request.turnId)).toEqual([...turnIds]);
  });

  it("checkpoints the repair's own commit once the checks agree", async () => {
    redUntil(2);

    const outcome = await run();

    const state = await jobs();
    expect(state.checkpointSha).toBe(COMMIT_SHA);
    expect(state.atCheckpoint).toBe(true);
    expect(outcome).toMatchObject({ ok: true, commitSha: COMMIT_SHA });
  });
});

describe("the attempt cap", () => {
  it("spends three repairs and no more", async () => {
    alwaysRed();

    await run();

    // Four turns: the user's, then three repairs. The fourth repair is the one that must not
    // happen, and counting the turns is the only way to see that it did not.
    expect(agent.calls).toBe(MAX_REPAIR_ATTEMPTS + 1);
    expect(await promptSources()).toEqual(["user", "verification", "verification", "verification"]);
  });

  it("closes the job exhausted, and reverts nothing", async () => {
    alwaysRed();

    const outcome = await run();

    const state = await jobs();
    expect(state.jobs.at(-1)).toMatchObject({
      phase: "exhausted",
      attemptsUsed: MAX_REPAIR_ATTEMPTS,
      attemptsRemaining: 0,
    });
    // The code stays committed and HEAD stays off the checkpoint, reported honestly: a user can
    // usually close that gap with one sentence, and reverting would throw the work away.
    expect(state.headSha).toBe(COMMIT_SHA);
    expect(state.checkpointSha).toBeNull();
    expect(state.atCheckpoint).toBe(false);
    expect(outcome).toMatchObject({ ok: true, commitSha: COMMIT_SHA });
  });

  it("stops the moment the checks pass, rather than spending what it is allowed", async () => {
    redUntil(3);

    await run();

    expect(agent.calls).toBe(3);
    expect((await jobs()).jobs.at(-1)).toMatchObject({ phase: "verified", attemptsUsed: 2 });
  });

  it("ends the job exactly once, however many turns it took", async () => {
    alwaysRed();

    await run();

    const types = await loggedTypes();
    expect(countOf(types, "job.started")).toBe(1);
    expect(countOf(types, "job.completed")).toBe(1);
    expect(countOf(types, "job.checkpointed")).toBe(0);
  });
});

describe("a crash inside a repair", () => {
  it("closes the turn and the job, rather than leaving a job something would continue", async () => {
    // The crash lands after a turn has already ended, which is the case the loop introduced: a
    // job left open here is one the next opening of this project would pick up and spend tokens
    // on, and the first turn's `turn.completed` is not this turn's ending.
    alwaysRed();
    let calls = 0;
    agent = new ScriptedAgent(() => completedTurn(COMMIT_SHA), true);
    agent.before = async () => {
      calls += 1;
      if (calls > 1) throw new Error("provider exploded");
    };

    const outcome = await run();

    expect(outcome).toMatchObject({ ok: false, reason: "internal" });
    const types = await loggedTypes();
    expect(countOf(types, "turn.failed")).toBe(1);
    expect(countOf(types, "job.completed")).toBe(1);
    expect((await jobs()).jobs.at(-1)?.phase).toBe("abandoned");
  });
});

describe("cancelling a job mid-repair", () => {
  it("stops the loop rather than only the turn it was in", async () => {
    alwaysRed();
    const controller = new AbortController();
    // Aborted while the first turn is inside the agent, which is where a cancel from the API
    // lands. The turn itself is a fixture and runs to completion; what must not happen is the
    // loop starting a repair on a job somebody has stopped.
    agent.before = async () => controller.abort();

    await run({ signal: controller.signal });

    expect(agent.calls).toBe(1);
    expect(await promptSources()).toEqual(["user"]);
    expect((await jobs()).jobs.at(-1)?.phase).toBe("abandoned");
  });

  it("abandons the job when a repair turn is the one that is cancelled", async () => {
    // The other half: the cancel lands inside a repair turn, so that turn reports `cancelled`
    // and the job goes with it rather than being repaired again.
    alwaysRed();
    const cancelledTurn: AgentScript = () => [
      { type: "turn.started", payload: {} },
      { type: "turn.failed", payload: { reason: "cancelled", message: "The turn was cancelled." } },
    ];
    let calls = 0;
    agent = new ScriptedAgent((request) => {
      calls += 1;
      return calls === 1 ? completedTurn(COMMIT_SHA) : cancelledTurn(request);
    }, true);

    const outcome = await run();

    expect(agent.calls).toBe(2);
    expect(outcome).toMatchObject({ ok: false, reason: "cancelled" });
    expect((await jobs()).jobs.at(-1)?.phase).toBe("abandoned");
  });
});
