/**
 * A turn's claim, and what the runtime does about it.
 *
 * v1 ended a turn on the model's word. These pin the level above that: a turn that changed the
 * workspace is committed and *then* checked, a passing check makes the commit a checkpoint, and
 * a turn that changed nothing is never checked at all (`docs/adr/0006`).
 *
 * The assertions are on the log and on the commands that reached the sandbox, and the log is
 * read back through `foldJobs` wherever the question is about state rather than about which
 * events were written — that fold is what the API and the browser will both answer from, so a
 * checkpoint nothing can recover from the log is not a checkpoint.
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
import { NapEventSchema, type NapEventType } from "@nap/shared/events";
import { PROJECT_ROOT_PATH } from "@nap/shared/files-protocol";
import { foldJobs } from "@nap/shared/job-state";
import { beforeEach, describe, expect, it } from "vitest";
import { SingleAgentRuntime } from "./single-agent-runtime.ts";

const SESSION_ID = "2a3f8a24-6c1b-4e0e-9b6f-3a5c0a1d9e77";
const PROJECT_ID = "4d5e6f70-1a2b-4c3d-8e9f-0a1b2c3d4e5f";
const COMMIT_SHA = "9e107d9d372bb6826bd81d3542a419d6c2b0f5a1";

const MANIFEST = JSON.stringify({
  scripts: { typecheck: "tsc --noEmit", test: "vitest" },
});

const failedTurn: AgentScript = () => [
  { type: "turn.started", payload: {} },
  { type: "turn.failed", payload: { reason: "refusal", message: "declined" } },
];

let sandbox: InMemorySandboxManager;
let events: InMemoryEventStore;
let sessions: InMemorySessionStore;

/** A project whose sandbox serves and whose git answers; `dirty` is whether the turn changed it. */
function projectSandbox(dirty = true): InMemorySandboxManager {
  // Seeded with a manifest, as a real sandbox comes up from its template: the verifier reads
  // it to find out which checks the project has, and a sandbox without one teaches it nothing.
  const manager = new InMemorySandboxManager({
    serves: [TEMPLATE_DEV_PORT],
    seed: { [`${PROJECT_ROOT_PATH}/package.json`]: MANIFEST },
  });
  return scriptGit(manager, { dirty });
}

/** Green everywhere, which is the case a checkpoint comes out of. */
function passingChecks(): InMemorySandboxManager {
  return sandbox
    .script(/bun run typecheck/, { exitCode: 0 })
    .script(/bun run test/, { exitCode: 0 });
}

beforeEach(() => {
  sandbox = projectSandbox();
  events = new InMemoryEventStore();
  sessions = new InMemorySessionStore([{ sessionId: SESSION_ID, projectId: PROJECT_ID }]);
});

const run = (
  script: AgentScript = () => completedTurn(COMMIT_SHA),
  verification: "arbitrate" | "trust" = "arbitrate",
) =>
  new SingleAgentRuntime({
    sessions,
    sandbox,
    context: new StubContextEngine(),
    // Finalizing, so the sha in `turn.completed` is the one the commit produced rather than a
    // literal — "did this turn change anything" is git's answer here, as it is in production.
    agent: new ScriptedAgent(script, true),
    events,
    bus: new InMemoryEventBus(),
    memory: new NoopMemoryProvider(),
    verification,
  }).runTurn({ sessionId: SESSION_ID, message: "add a delete button" });

async function loggedTypes(): Promise<NapEventType[]> {
  return (await events.readFrom(SESSION_ID, 0)).map((event) => event.type);
}

async function jobs() {
  return foldJobs(await events.readFrom(SESSION_ID, 0));
}

/** What the verifier actually asked the project, as against what git was asked. */
async function checkCommands(): Promise<string[]> {
  const sandboxId = (await sessions.get(SESSION_ID))?.sandboxId ?? "";
  return sandbox.commands(sandboxId).filter((command) => /bun run |curl/.test(command));
}

describe("a turn that changed the workspace", () => {
  it("verifies the commit it just made, and checkpoints it when the checks agree", async () => {
    passingChecks();

    await run();

    expect(await loggedTypes()).toEqual([
      "user.message",
      "job.started",
      // The sandbox was created by this turn and is serving, so the preview is announced.
      "preview.ready",
      "turn.started",
      "turn.completed",
      "verification.started",
      "verification.completed",
      "job.checkpointed",
      "job.completed",
    ]);
  });

  it("records the checkpoint's sha where the fold can recover it", async () => {
    passingChecks();

    await run();

    const state = await jobs();
    expect(state.checkpointSha).toBe(COMMIT_SHA);
    expect(state.headSha).toBe(COMMIT_SHA);
    expect(state.atCheckpoint).toBe(true);
    expect(state.jobs.at(-1)?.phase).toBe("verified");
  });

  it("runs the checks the project declares, and says so about the ones it does not", async () => {
    passingChecks();

    await run();

    const [job] = (await jobs()).jobs;
    expect(job?.checks.map((check) => [check.name, check.outcome])).toEqual([
      ["typecheck", "passed"],
      ["lint", "absent"],
      ["build", "absent"],
      ["test", "passed"],
      ["preview", "passed"],
    ]);
  });

  it("checkpoints nothing when a check says no, however the job ends", async () => {
    // This scripted agent repairs nothing, so the check stays red through every attempt and the
    // job runs out of them. What the repair loop does in between is `repair-loop.test.ts`'s.
    sandbox.script(/bun run typecheck/, { exitCode: 2, stderr: "error TS2304" });

    await run();

    expect(await loggedTypes()).not.toContain("job.checkpointed");
    const state = await jobs();
    // Committed, unverified, and honest about it: HEAD has diverged from the last checkpoint,
    // and exhaustion reverts nothing (docs/adr/0006).
    expect(state.headSha).toBe(COMMIT_SHA);
    expect(state.checkpointSha).toBeNull();
    expect(state.atCheckpoint).toBe(false);
    expect(state.jobs.at(-1)?.phase).toBe("exhausted");
  });

  it("keeps what the failing check said, for the turn that will have to fix it", async () => {
    sandbox.script(/bun run typecheck/, { exitCode: 2, stderr: "App.tsx(3,1): error TS2304" });

    await run();

    const [job] = (await jobs()).jobs;
    expect(job?.checks[0]).toStrictEqual({
      name: "typecheck",
      outcome: "failed",
      output: "App.tsx(3,1): error TS2304",
    });
  });

  it("does not fail the turn because its checks did", async () => {
    // The model's work happened and is committed. A red check is a job that is not finished,
    // not a turn that did not happen — and reporting it as a failed turn would put a retry
    // button under work the user can see in the preview.
    sandbox.script(/bun run typecheck/, { exitCode: 2 });

    await expect(run()).resolves.toStrictEqual({
      ok: true,
      turnId: expect.any(String),
      commitSha: COMMIT_SHA,
    });
  });
});

describe("a turn that changed nothing", () => {
  beforeEach(() => {
    sandbox = projectSandbox(false);
  });

  it("is never verified — there is no claim about the code to arbitrate", async () => {
    await run();

    const types = await loggedTypes();
    expect(types).not.toContain("verification.started");
    expect(types).not.toContain("verification.completed");
    expect(await checkCommands()).toEqual([]);
  });

  it("closes its job unverified, which is neither a pass nor a failure", async () => {
    await run();

    const state = await jobs();
    expect(state.jobs.at(-1)).toMatchObject({ phase: "unverified", checks: [] });
    expect(state.checkpointSha).toBeNull();
  });
});

describe("a composition asked to trust its turns", () => {
  // The benchmark's control arm, and nothing else: it is v1's behaviour, kept reachable so that
  // the two arms of a before/after measurement differ in the loop rather than in every commit
  // between two checkouts. What it must not do is look like a pass.
  it("commits, checks nothing, and closes the job unverified", async () => {
    passingChecks();

    await run(undefined, "trust");

    expect(await loggedTypes()).toEqual([
      "user.message",
      "job.started",
      "preview.ready",
      "turn.started",
      "turn.completed",
      "job.completed",
    ]);
    expect(await checkCommands()).toEqual([]);

    const state = await jobs();
    expect(state.jobs.at(-1)).toMatchObject({ phase: "unverified", checks: [] });
    expect(state.headSha).toBe(COMMIT_SHA);
    // Nothing agreed with this commit, so it is not a checkpoint. A trusted turn that quietly
    // checkpointed would make "is this project valid" answer yes on the strength of nothing.
    expect(state.checkpointSha).toBeNull();
    expect(state.atCheckpoint).toBe(false);
  });

  it("never repairs, because nothing ever says no", async () => {
    sandbox.script(/bun run typecheck/, { exitCode: 2, stderr: "error TS2304" });

    await run(undefined, "trust");

    const types = await loggedTypes();
    expect(types).not.toContain("verification.started");
    expect(types).not.toContain("verification.completed");
    // One turn, and one only: a repair turn is prompted by a failed check, and no check ran.
    expect(types.filter((type) => type === "turn.started")).toHaveLength(1);
  });
});

describe("a turn that failed", () => {
  it("commits nothing, verifies nothing, and abandons its job", async () => {
    const outcome = await run(failedTurn);

    expect(outcome).toMatchObject({ ok: false, reason: "refusal" });
    expect(await checkCommands()).toEqual([]);
    expect(await loggedTypes()).toEqual([
      "user.message",
      "job.started",
      // The sandbox was created by this turn and is serving, so the preview is announced.
      "preview.ready",
      "turn.started",
      "turn.failed",
      "job.completed",
    ]);
    expect((await jobs()).jobs.at(-1)?.phase).toBe("abandoned");
  });
});

describe("a verification that learned nothing", () => {
  it("is never written as one, and abandons the job instead of checkpointing it", async () => {
    // No manifest to discover checks from — the sandbox told us nothing about the project. An
    // all-absent payload would fold to `verified` and checkpoint a commit nothing ran against.
    sandbox = scriptGit(new InMemorySandboxManager({ serves: [TEMPLATE_DEV_PORT] }));

    await run();

    const types = await loggedTypes();
    expect(types).toContain("verification.started");
    expect(types).not.toContain("verification.completed");
    expect(types).not.toContain("job.checkpointed");

    const state = await jobs();
    expect(state.jobs.at(-1)?.phase).toBe("abandoned");
    expect(state.checkpointSha).toBeNull();
  });
});

describe("the job log", () => {
  it("names what was asked, so the objective survives without counting turn boundaries", async () => {
    passingChecks();

    await run();

    expect((await jobs()).jobs.at(-1)?.objective).toBe("add a delete button");
  });

  it("is parseable by every consumer of the event contract", async () => {
    passingChecks();

    await run();

    for (const event of await events.readFrom(SESSION_ID, 0)) {
      expect(() => NapEventSchema.parse(event)).not.toThrow();
    }
  });
});
