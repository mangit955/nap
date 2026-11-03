/**
 * Plan mode through the whole composition: a real agent, a real context engine and the runtime,
 * with the model scripted and the sandbox in memory (ADR-0024).
 *
 * What is asserted is what the person relies on. A plan mode turn changes nothing — no job, no
 * commit, no snapshot — and ends waiting on them. Approving it opens a job that carries the plan
 * in its prompt and commits like any other. An approval that arrives after the plan was settled
 * builds nothing. Never asserted: anything a model said.
 */

import { NapAgentService } from "@nap/agent/agent-service";
import { ScriptedLLMProvider, type ScriptedTurn } from "@nap/agent/testing/scripted-llm-provider";
import { NapContextEngine } from "@nap/context/context-engine";
import { NoopMemoryProvider } from "@nap/context/noop-memory-provider";
import { PLAN_MODE_PROMPT } from "@nap/context/system-prompt";
import { expectEventSequence } from "@nap/db/testing/event-assertions";
import { InMemoryEventBus } from "@nap/db/testing/in-memory-event-bus";
import { InMemoryEventStore } from "@nap/db/testing/in-memory-event-store";
import { InMemorySessionStore } from "@nap/db/testing/in-memory-session-store";
import { InMemorySnapshotStore } from "@nap/db/testing/in-memory-snapshot-store";
import { InMemorySandboxManager } from "@nap/sandbox/testing/in-memory-sandbox-manager";
import { scriptGit } from "@nap/sandbox/testing/script-git";
import type { PlanIntent } from "@nap/shared/agent-plan";
import { NapEventSchema } from "@nap/shared/events";
import { InMemoryObjectStore } from "@nap/storage/testing/in-memory-object-store";
import { beforeEach, describe, expect, it } from "vitest";
import { SingleAgentRuntime } from "./single-agent-runtime.ts";

const SESSION_ID = "2a3f8a24-6c1b-4e0e-9b6f-3a5c0a1d9e77";
const PROJECT_ID = "4d5e6f70-1a2b-4c3d-8e9f-0a1b2c3d4e5f";
const PLAN = { title: "Dark theme", plan: "1. Add colour tokens\n2. Add a toggle in the header" };

let sandbox: InMemorySandboxManager;
let events: InMemoryEventStore;
let sessions: InMemorySessionStore;
let snapshots: InMemorySnapshotStore;

beforeEach(() => {
  sandbox = scriptGit(new InMemorySandboxManager());
  events = new InMemoryEventStore();
  sessions = new InMemorySessionStore([{ sessionId: SESSION_ID, projectId: PROJECT_ID }]);
  snapshots = new InMemorySnapshotStore();
});

function subject(turns: ScriptedTurn[]) {
  const provider = new ScriptedLLMProvider(turns);
  const runtime = new SingleAgentRuntime({
    sessions,
    sandbox,
    context: new NapContextEngine(),
    agent: new NapAgentService({ provider }),
    events,
    bus: new InMemoryEventBus(),
    memory: new NoopMemoryProvider(),
    objects: new InMemoryObjectStore(),
    snapshots,
  });
  return { provider, runtime };
}

const proposing: ScriptedTurn = [
  {
    toolCalls: [
      { id: "read", name: "list_files", input: { path: "/home/user/app" } },
      { id: "plan", name: "propose_plan", input: PLAN },
    ],
  },
];

async function turn(
  runtime: SingleAgentRuntime,
  message: string,
  plan?: PlanIntent,
): Promise<{ turnId: string; outcome: Awaited<ReturnType<SingleAgentRuntime["runTurn"]>> }> {
  const turnId = crypto.randomUUID();
  const outcome = await runtime.runTurn({
    turnId,
    sessionId: SESSION_ID,
    message,
    ...(plan === undefined ? {} : { plan }),
  });
  return { turnId, outcome };
}

async function commits(): Promise<string[]> {
  const sandboxId = (await sessions.get(SESSION_ID))?.sandboxId;
  if (sandboxId == null) return [];
  return sandbox.commands(sandboxId).filter((command) => /git .*commit -m/.test(command));
}

describe("a plan mode turn", () => {
  it("opens no job, commits and snapshots nothing, and ends awaiting approval", async () => {
    const { runtime, provider } = subject([proposing]);

    const { outcome } = await turn(runtime, "add a dark theme", { intent: "propose" });

    expect(outcome).toMatchObject({ ok: true, commitSha: null });
    const log = await events.readFrom(SESSION_ID, 0);
    expectEventSequence(log, [
      "user.message",
      "turn.started",
      "context.usage",
      "context.usage",
      "tool.call",
      "tool.result",
      "tool.call",
      "plan.proposed",
      "tool.result",
      "turn.completed",
    ]);
    expect(
      log.some((event) => event.type.startsWith("job.") || event.type.startsWith("verif")),
    ).toBe(false);
    expect(log[0]?.payload).toMatchObject({ plan: { intent: "propose" } });
    expect(log.at(-1)?.payload).toMatchObject({ commitSha: null, awaiting: "plan_approval" });
    expect(await commits()).toEqual([]);
    expect(snapshots.all()).toEqual([]);
    for (const event of log) expect(() => NapEventSchema.parse(event)).not.toThrow();

    // The context engine was told, and the agent offered nothing that writes.
    const sent = provider.requests[0];
    expect(sent?.systemPrompt).toContain(PLAN_MODE_PROMPT);
    expect(sent?.tools.map((tool) => tool.name)).not.toContain("write_file");
  });

  it("commits nothing even when it stops without proposing, so a planning turn can never build", async () => {
    // The model writes nothing it is allowed to, then answers twice without a plan. The agent's own
    // skip covers only a turn that ended on a proposal; this is the runtime withholding the commit.
    const { runtime } = subject([
      [{ text: "Looks fine already." }, { text: "Nothing to change." }],
    ]);

    const { outcome } = await turn(runtime, "is the header sticky?", { intent: "propose" });

    expect(outcome).toMatchObject({ ok: true, commitSha: null });
    expect(await commits()).toEqual([]);
    const log = await events.readFrom(SESSION_ID, 0);
    expect(log.at(-1)?.payload).not.toHaveProperty("awaiting");
  });

  it("is carried out by the approval: a job named for the plan, the plan in every prompt, a commit", async () => {
    const { runtime, provider } = subject([proposing, [{ text: "Built it." }]]);
    const planned = await turn(runtime, "add a dark theme", { intent: "propose" });

    const { outcome } = await turn(runtime, "Approved. Build this plan.", {
      intent: "approve",
      planTurnId: planned.turnId,
    });

    expect(outcome).toMatchObject({ ok: true });
    const log = await events.readFrom(SESSION_ID, 0);
    const opened = log.find((event) => event.type === "job.started");
    expect(opened?.payload).toMatchObject({ objective: PLAN.title });
    const building = provider.requests[1];
    expect(building?.systemPrompt).toContain("<approved_plan>");
    expect(building?.systemPrompt).toContain(PLAN.plan);
    expect(building?.systemPrompt).not.toContain(PLAN_MODE_PROMPT);
    expect(building?.tools.map((tool) => tool.name)).toContain("write_file");
    expect(await commits()).toHaveLength(1);
  });

  it("builds nothing when the plan an approval names was already settled", async () => {
    const { runtime, provider } = subject([proposing, [{ text: "ok" }]]);
    const planned = await turn(runtime, "add a dark theme", { intent: "propose" });
    // The person moved on; the plan is no longer the open question.
    await turn(runtime, "actually, make the header sticky");
    const before = provider.requests.length;

    const { outcome } = await turn(runtime, "Approved. Build this plan.", {
      intent: "approve",
      planTurnId: planned.turnId,
    });

    expect(outcome).toMatchObject({ ok: false, reason: "internal" });
    expect(provider.requests).toHaveLength(before);
    const log = await events.readFrom(SESSION_ID, 0);
    expect(log.slice(-2).map((event) => event.type)).toEqual(["user.message", "turn.failed"]);
    expect(await commits()).toHaveLength(1);
  });
});
