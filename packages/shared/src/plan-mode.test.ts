import { describe, expect, it } from "vitest";
import type { NapEvent } from "./events.ts";
import { approvedPlanOfJob, pendingPlan, planStates } from "./plan-mode.ts";
import type { StoredEvent } from "./ports/event-store.ts";

const SESSION = "0b7f8f1e-3c2a-4d5b-9e6f-1a2b3c4d5e6f";
const PLAN_TURN = "3f9a1c2d-5e6b-4f7a-8b9c-0d1e2f3a4b5c";
const NEXT_TURN = "8c7b6a59-4d3e-4f21-9a8b-7c6d5e4f3a2b";
const OTHER_PLAN_TURN = "7c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f";

type Entry = { type: NapEvent["type"]; turnId: string; payload: unknown };

/** A log out of payloads, `seq` by position: the fold reads nothing else. */
function log(...entries: readonly Entry[]): StoredEvent[] {
  return entries.map(
    (entry, seq) =>
      ({
        ...entry,
        sessionId: SESSION,
        createdAt: "2026-11-03T12:00:00.000Z",
        seq,
      }) as StoredEvent,
  );
}

const ask = (turnId: string, plan?: unknown): Entry => ({
  type: "user.message",
  turnId,
  payload: { text: "make it dark", ...(plan === undefined ? {} : { plan }) },
});
const proposed = (turnId: string, title = "Dark theme"): Entry => ({
  type: "plan.proposed",
  turnId,
  payload: { toolCallId: "call-1", title, plan: "1. Add tokens\n2. Swap colours" },
});
const completed = (turnId: string): Entry => ({
  type: "turn.completed",
  turnId,
  payload: {
    usage: { inputTokens: 1, outputTokens: 1 },
    durationMs: 1,
    commitSha: null,
    awaiting: "plan_approval",
  },
});
const failed = (turnId: string): Entry => ({
  type: "turn.failed",
  turnId,
  payload: { reason: "cancelled", message: "The turn was cancelled." },
});

const planning = (turnId = PLAN_TURN) => [
  ask(turnId, { intent: "propose" }),
  proposed(turnId),
  completed(turnId),
];

describe("planStates", () => {
  it("leaves a proposal awaiting approval once its turn completes and nothing has been said since", () => {
    const states = planStates(log(...planning()));
    expect(states.get(PLAN_TURN)).toMatchObject({
      status: "awaiting",
      title: "Dark theme",
      plan: "1. Add tokens\n2. Swap colours",
    });
  });

  it("is still being written while its turn is open, so it cannot be approved yet", () => {
    const states = planStates(log(ask(PLAN_TURN, { intent: "propose" }), proposed(PLAN_TURN)));
    expect(states.get(PLAN_TURN)?.status).toBe("drafting");
  });

  it("is interrupted when the turn it was proposed in fails", () => {
    const states = planStates(
      log(ask(PLAN_TURN, { intent: "propose" }), proposed(PLAN_TURN), failed(PLAN_TURN)),
    );
    expect(states.get(PLAN_TURN)?.status).toBe("interrupted");
  });

  it("is approved by the next message when that message approves this turn's plan", () => {
    const states = planStates(
      log(...planning(), ask(NEXT_TURN, { intent: "approve", planTurnId: PLAN_TURN })),
    );
    expect(states.get(PLAN_TURN)?.status).toBe("approved");
  });

  it("is revised when the next message asks for another plan", () => {
    const states = planStates(log(...planning(), ask(NEXT_TURN, { intent: "propose" })));
    expect(states.get(PLAN_TURN)?.status).toBe("revised");
  });

  it("is superseded by an ordinary message, which moves on without approving it", () => {
    const states = planStates(log(...planning(), ask(NEXT_TURN)));
    expect(states.get(PLAN_TURN)?.status).toBe("superseded");
  });

  it("is not settled by an approval naming a plan that is not waiting, which builds nothing", () => {
    // The runtime refuses that approval under the lease, so counting it as an answer would set
    // aside the plan the person is actually looking at.
    const states = planStates(
      log(...planning(), ask(NEXT_TURN, { intent: "approve", planTurnId: OTHER_PLAN_TURN })),
    );
    expect(states.get(PLAN_TURN)?.status).toBe("awaiting");
  });

  it("is not set aside by a stale approval of an older plan that lands after a revision", () => {
    const states = planStates(
      log(
        ...planning(),
        ...planning(OTHER_PLAN_TURN),
        ask(NEXT_TURN, { intent: "approve", planTurnId: PLAN_TURN }),
        failed(NEXT_TURN),
      ),
    );
    expect(states.get(PLAN_TURN)?.status).toBe("revised");
    expect(states.get(OTHER_PLAN_TURN)?.status).toBe("awaiting");
  });

  it("is waiting again when the turn approving it fails, because that turn committed nothing", () => {
    const events = log(
      ...planning(),
      ask(NEXT_TURN, { intent: "approve", planTurnId: PLAN_TURN }),
      failed(NEXT_TURN),
    );
    expect(planStates(events).get(PLAN_TURN)?.status).toBe("awaiting");
    expect(pendingPlan(events, PLAN_TURN)).toMatchObject({ title: "Dark theme" });
  });

  it("does not reopen an older plan when another request arrived before the approval failed", () => {
    const states = planStates(
      log(
        ...planning(),
        ask(NEXT_TURN, { intent: "approve", planTurnId: PLAN_TURN }),
        ...planning(OTHER_PLAN_TURN),
        failed(NEXT_TURN),
      ),
    );
    expect(states.get(PLAN_TURN)?.status).toBe("revised");
    expect(states.get(OTHER_PLAN_TURN)?.status).toBe("awaiting");
  });

  it("stays approved when a repair turn of the job it opened fails later", () => {
    const REPAIR_TURN = "5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a";
    const repair: Entry = {
      type: "user.message",
      turnId: REPAIR_TURN,
      payload: {
        text: "typecheck failed",
        repair: { requestId: NEXT_TURN, jobId: OTHER_PLAN_TURN },
      },
    };
    const states = planStates(
      log(
        ...planning(),
        ask(NEXT_TURN, { intent: "approve", planTurnId: PLAN_TURN }),
        completed(NEXT_TURN),
        repair,
        failed(REPAIR_TURN),
      ),
    );
    expect(states.get(PLAN_TURN)?.status).toBe("approved");
  });

  it("stays settled: a later approval cannot reach a plan the person already moved past", () => {
    const states = planStates(
      log(
        ...planning(),
        ask(NEXT_TURN),
        ask(OTHER_PLAN_TURN, { intent: "approve", planTurnId: PLAN_TURN }),
      ),
    );
    expect(states.get(PLAN_TURN)?.status).toBe("superseded");
  });

  it("is not settled by a repair prompt, which is the verifier speaking rather than the person", () => {
    const repair: Entry = {
      type: "user.message",
      turnId: NEXT_TURN,
      payload: {
        text: "typecheck failed",
        repair: { requestId: NEXT_TURN, jobId: OTHER_PLAN_TURN },
      },
    };
    const states = planStates(log(...planning(), repair));
    expect(states.get(PLAN_TURN)?.status).toBe("awaiting");
  });

  it("keeps the last proposal of a turn that proposed twice", () => {
    const states = planStates(
      log(
        ask(PLAN_TURN, { intent: "propose" }),
        proposed(PLAN_TURN, "First"),
        proposed(PLAN_TURN, "Second"),
        completed(PLAN_TURN),
      ),
    );
    expect(states.get(PLAN_TURN)?.title).toBe("Second");
    expect(states.size).toBe(1);
  });
});

describe("pendingPlan", () => {
  it("finds the plan a turn approves only while it is still awaiting approval", () => {
    expect(pendingPlan(log(...planning()), PLAN_TURN)).toMatchObject({ title: "Dark theme" });
    expect(pendingPlan(log(...planning(), ask(NEXT_TURN)), PLAN_TURN)).toBeUndefined();
    expect(pendingPlan(log(...planning()), OTHER_PLAN_TURN)).toBeUndefined();
  });
});

describe("approvedPlanOfJob", () => {
  const JOB = "1f2e3d4c-5b6a-4978-8a9b-0c1d2e3f4a5b";
  const opened: Entry = {
    type: "job.started",
    turnId: NEXT_TURN,
    payload: { jobId: JOB, objective: "Dark theme" },
  };

  it("finds the plan a job was opened to carry out, so a continued job keeps building it", () => {
    const events = log(
      ...planning(),
      ask(NEXT_TURN, { intent: "approve", planTurnId: PLAN_TURN }),
      opened,
    );
    expect(approvedPlanOfJob(events, JOB)).toEqual({
      title: "Dark theme",
      plan: "1. Add tokens\n2. Swap colours",
    });
  });

  it("finds nothing for a job opened by an ordinary prompt, or a job it has never heard of", () => {
    const events = log(...planning(), ask(NEXT_TURN), opened);
    expect(approvedPlanOfJob(events, JOB)).toBeUndefined();
    expect(approvedPlanOfJob(events, PLAN_TURN)).toBeUndefined();
  });
});
