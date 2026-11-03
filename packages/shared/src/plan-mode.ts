/**
 * Where every proposed plan stands, read off the event log.
 *
 * There is no plans table and no approval flag anywhere: a plan is a `plan.proposed` event, and
 * what became of it is whatever the person said next (ADR-0024). Folding that here, once, is what
 * lets the chat pane draw a card as settled and the runtime refuse a stale approval *by the same
 * rule* — two folds would be two opinions about which plan is still open.
 *
 * The next message settles a plan, whatever it is. Approving it is one answer; asking for another
 * plan is another; saying anything else is moving on. That is the same rule a question follows,
 * and for the same reason: in a chat, the next thing somebody says *is* their answer.
 */

import type { ProposedPlan } from "./agent-plan.ts";
import type { NapEvent } from "./events.ts";

export type PlanStatus =
  /** Proposed in a turn that is still running. Not yet something to approve. */
  | "drafting"
  /** The turn ended on it and nobody has said anything since. The one approvable state. */
  | "awaiting"
  /** The next message approved it, which started the turn that carries it out. */
  | "approved"
  /** The next message asked for another plan. */
  | "revised"
  /** The next message moved on without approving it. */
  | "superseded"
  /** The turn it was proposed in failed, so it was never finished. */
  | "interrupted";

export type PlanState = ProposedPlan & {
  /** The plan mode turn that proposed it — what an approval names. */
  turnId: string;
  toolCallId: string;
  /** The `seq` of the proposal, a stable key for whoever draws it. */
  seq: number;
  status: PlanStatus;
};

type Readable = Pick<NapEvent, "type" | "turnId" | "payload"> & { seq: number };

/** Every plan in the log, keyed by the turn that proposed it, in the order they were proposed. */
export function planStates(events: readonly Readable[]): Map<string, PlanState> {
  const states = new Map<string, PlanState>();
  for (const event of events) {
    switch (event.type) {
      case "plan.proposed": {
        const { toolCallId, title, plan } = (event as Extract<NapEvent, { type: "plan.proposed" }>)
          .payload;
        // A turn that proposed twice meant the second: the first never reached the person as an
        // answer, because the turn had not ended on it.
        states.delete(event.turnId);
        states.set(event.turnId, {
          turnId: event.turnId,
          toolCallId,
          title,
          plan,
          seq: event.seq,
          status: "drafting",
        });
        break;
      }
      case "turn.completed":
      case "turn.failed": {
        const state = states.get(event.turnId);
        if (state?.status === "drafting")
          state.status = event.type === "turn.completed" ? "awaiting" : "interrupted";
        break;
      }
      case "user.message": {
        const { plan, repair } = (event as Extract<NapEvent, { type: "user.message" }>).payload;
        // A repair prompt is the verifier's, written inside a job; it answers nothing the person
        // was asked.
        if (repair !== undefined) break;
        for (const state of states.values()) {
          if (state.turnId === event.turnId) continue;
          if (state.status !== "drafting" && state.status !== "awaiting") continue;
          state.status =
            plan?.intent === "approve" && plan.planTurnId === state.turnId
              ? "approved"
              : plan?.intent === "propose"
                ? "revised"
                : "superseded";
        }
        break;
      }
      default:
        break;
    }
  }
  return states;
}

/** The plan `planTurnId` proposed, if it is still waiting for approval; otherwise nothing. */
export function pendingPlan(
  events: readonly Readable[],
  planTurnId: string,
): PlanState | undefined {
  const state = planStates(events).get(planTurnId);
  return state?.status === "awaiting" ? state : undefined;
}

/**
 * The plan a job was opened to carry out, if one was (ADR-0024).
 *
 * Read back from the log rather than stored on the job, because the log already says it: the
 * job opens in the same turn as the prompt that approved the plan, and that prompt names the turn
 * that proposed it. A job a restart continues finds its plan here, with nothing new written down.
 */
export function approvedPlanOfJob(
  events: readonly Readable[],
  jobId: string,
): ProposedPlan | undefined {
  const opened = events.find(
    (event) =>
      event.type === "job.started" &&
      (event as Extract<NapEvent, { type: "job.started" }>).payload.jobId === jobId,
  );
  if (opened === undefined) return undefined;
  const prompt = events.find(
    (event) => event.type === "user.message" && event.turnId === opened.turnId,
  ) as Extract<NapEvent, { type: "user.message" }> | undefined;
  const intent = prompt?.payload.plan;
  if (intent?.intent !== "approve") return undefined;
  const state = planStates(events).get(intent.planTurnId);
  return state === undefined ? undefined : { title: state.title, plan: state.plan };
}
