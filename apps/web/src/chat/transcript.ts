import type { MediaAttachment } from "@nap/shared/media";
/**
 * Turning an event log into the things a reader sees.
 *
 * The log is a flat, ordered stream of typed events; a transcript is a much shorter list
 * of blocks, because a tool call, everything it printed, the files it touched and how it ended
 * are one thing on screen and four kinds of event in the log. This fold is where that
 * difference lives, and keeping it a pure function is what lets the interesting cases —
 * interleaved tool calls, a stream still arriving — be tested without rendering anything.
 *
 * Two rules do most of the work:
 *
 *   - **A result belongs to the call with its `toolCallId`, never to whichever step is last.**
 *     Tools can be answered out of order, and attributing a failure to the wrong step tells the
 *     user the wrong command broke.
 *   - **`file.changed` attaches to the step that is still open.** It carries no `toolCallId`,
 *     and the only reason it does not need one is that the tools emit it between a call and its
 *     result (`packages/agent/src/tools/execute.ts`). Outside a step it stands alone rather than
 *     being dropped — losing it would lose the only record that a file changed.
 *
 * The whole event list is re-folded on every frame, since that is what the stream hook hands
 * back, so output accumulates by appending to the item being built rather than by mutating
 * anything that survives the call.
 */

import type {
  PlanIntent,
  PlanItem,
  QuestionOption,
  SubagentOutcome,
  SubagentProfile,
} from "@nap/shared/agent-plan";
import type { NapEventOf, PromptSource, ToolName } from "@nap/shared/events";
import { type PlanStatus, planStates } from "@nap/shared/plan-mode";
import type { StoredEvent } from "@nap/shared/ports/event-store";
import { type AppTestState, foldAppTests } from "../computer/app-test-state.ts";
import { inFlightTurn } from "./working-state.ts";

export type FileChange = {
  path: string;
  changeType: NapEventOf<"file.changed">["payload"]["changeType"];
  diff: string;
  added: number;
  removed: number;
};

export type StepStatus = "running" | "ok" | "failed";

export type HelperRun = {
  subagentId: string;
  profile: SubagentProfile;
  task: string;
  outcome: "running" | SubagentOutcome;
  summary: string | null;
  toolCalls: number;
};

/**
 * Who a block of prose came from.
 *
 * `verifier` is not a third speaker in the conversation — it is the same `user.message` event
 * every prompt is, written by the runtime instead of by a person (docs/adr/0006). It is told
 * apart here rather than in the component because the distinction is a fact about the log, and
 * it is the whole of what makes a repair read as the system correcting itself rather than as
 * the app talking to itself in the user's voice.
 */
export type Speaker = "user" | "agent" | "verifier";

export type CompactionItem = {
  kind: "compaction";
  key: number;
  id: string;
  turnId: string;
  trigger: NapEventOf<"compaction.started">["payload"]["trigger"] | null;
  startedAt: string | null;
} & (
  | { status: "running" }
  | ({ status: "completed"; finishedAt: string } & NapEventOf<"compaction.completed">["payload"])
  | ({ status: "failed"; finishedAt: string } & NapEventOf<"compaction.failed">["payload"])
);

export type TranscriptItem =
  | {
      kind: "message";
      key: number;
      from: Speaker;
      text: string;
      attachments?: MediaAttachment[] | undefined;
      /** Whether this prompt asked for a plan or approved one, so the bubble can say so. */
      plan?: PlanIntent | undefined;
    }
  | CompactionItem
  | { kind: "app-test"; key: number; test: AppTestState }
  | { kind: "thinking"; key: number; text: string }
  | {
      kind: "step";
      key: number;
      /** When the call was made, for the time a row shows on hover. */
      at: string;
      toolCallId: string;
      toolName: ToolName;
      input: Record<string, unknown>;
      status: StepStatus;
      /** What the tool told the model. Empty until the result arrives. */
      output: string;
      /** Everything `run_command` printed, in the order it printed it. */
      streamed: string;
      files: FileChange[];
      frame?: NapEventOf<"computer.screenshot">;
      desktop?: { state: "starting" | "ready"; at: string };
      /** What a `run_subagent` call handed off, and how it ended — a helper's own calls are not logged. */
      helper?: HelperRun;
    }
  /**
   * The agent's checklist, one per turn, drawn where it last changed so it stays beside the work
   * it describes. Keeps the key it was first drawn under, so the list updates rather than remounts.
   */
  | { kind: "plan"; key: number; turnId: string; items: PlanItem[] }
  /**
   * A question the agent ended its turn on. `answer` is the next thing the person said, which is
   * what answered it whether or not they clicked an option; `null` while it is still open.
   */
  | {
      kind: "question";
      key: number;
      question: string;
      options: QuestionOption[];
      multiSelect: boolean;
      answer: string | null;
      /**
       * Whether a plan mode turn asked it. Its answer then goes out as another plan mode message:
       * the person asked for nothing to be built, and clicking an option must not change that.
       */
      planning: boolean;
    }
  /**
   * A plan mode turn's proposal (ADR-0025). `status` is `planStates`'s answer over the whole log,
   * the same fold the runtime refuses a stale approval by, so a card that offers Approve is a card
   * the server will accept an approval for. Only `awaiting` is actionable; every other status is
   * drawn settled, which is what replaying an old session shows.
   */
  | {
      kind: "proposed-plan";
      key: number;
      turnId: string;
      title: string;
      plan: string;
      status: PlanStatus;
    }
  /**
   * A message the person sent while a turn ran (ADR-0026), drawn as theirs wherever it landed.
   *
   * `read` is drawn where the agent read it, which is the point of drawing it at all: everything
   * above it the agent did without it. `dropped` is drawn where it was given up, offering the words
   * back. The other three have not landed yet and are drawn after everything else — `waiting` for
   * a turn still running, `queued` for one that has ended (it becomes the next turn), and
   * `undelivered` once the session has been seen idle with it still unanswered. A steer that became
   * the next turn is not drawn as a steer at all: that turn's prompt is the same words.
   */
  | {
      kind: "steer";
      key: number;
      steerId: string;
      text: string;
      status: SteerStatus;
      reason?: "stopped" | "interrupted";
      /** The plan intent of the turn it was sent to, so sending it again plans rather than builds. */
      retryPlan?: PlanIntent | undefined;
    }
  | { kind: "computer-recording"; key: number; text: "Started recording" | "Stopped recording" }
  | { kind: "computer-frame"; key: number; frame: NapEventOf<"computer.screenshot"> }
  | { kind: "files"; key: number; files: FileChange[] }
  | { kind: "preview"; key: number; url: string; port: number }
  /**
   * The fact that the app stopped being served, and when.
   *
   * `superseded` means the project came back up afterwards, which makes this one history
   * rather than news. Both are kept — the chronology is real and a reader listening to the log
   * should hear it — but only the one that still describes the project is drawn: a project put
   * away and reopened five times over an afternoon otherwise stacks five identical lines in the
   * transcript, each contradicted by an event a few minutes later that renders as nothing.
   */
  | { kind: "preview-stopped"; key: number; superseded: boolean }
  | { kind: "notice"; key: number; level: "info" | "warning"; text: string }
  /** `at` on both ends is what a finished turn's "Worked for" is measured between. */
  | { kind: "turn-start"; key: number; at: string; source: PromptSource }
  | ({ kind: "turn-end"; key: number; at: string } & TurnOutcome);

export type SteerStatus = "waiting" | "queued" | "read" | "dropped" | "undelivered";

/** The statuses of a steer that has not landed, which are drawn after everything else. */
export const UNLANDED_STEERS: ReadonlySet<SteerStatus> = new Set([
  "waiting",
  "queued",
  "undelivered",
]);

export type TranscriptOptions = {
  /**
   * Through which `seq` the server has said this session has nothing queued or running. A steer
   * received at or before it that never landed anywhere never will — its turn was lost, or the
   * turn it became was cancelled while queued, neither of which writes anything — and is offered
   * back rather than drawn waiting for ever.
   */
  idleThroughSeq?: number | undefined;
};

type TurnOutcome =
  | {
      outcome: "completed";
      durationMs: number;
      inputTokens: number;
      outputTokens: number;
      commitSha: string | null;
    }
  | {
      outcome: "failed";
      turnId: string;
      reason: NapEventOf<"turn.failed">["payload"]["reason"];
      message: string;
      /**
       * The message that started *this* turn, so a retry re-sends the right one.
       *
       * Carried here rather than looked up by the component: by the time a second turn has
       * failed, "the last user message in the log" is a different message from the one that
       * began the turn being retried. Undefined when the log cannot identify the request.
       * A verification turn deliberately retries the user request it was repairing.
       */
      retryMessage: string | undefined;
      retryAttachments?: MediaAttachment[] | undefined;
      /**
       * Whether the retried prompt asked for or approved a plan. A plan mode turn retried as an
       * ordinary one would build what nobody approved, so the intent goes back with the words.
       */
      retryPlan?: PlanIntent | undefined;
      /** A matching immediate compaction terminal, or the running compaction this failure ends. */
      compactionFailureKey?: number;
    };

type Step = Extract<TranscriptItem, { kind: "step" }>;
type FailedTurnItem = Extract<TranscriptItem, { kind: "turn-end"; outcome: "failed" }>;

/**
 * The turns a failed check prompted, by id.
 *
 * A pass of its own, and it has to be: the runtime writes the synthesized prompt *before*
 * handing the turn to the agent, which is what emits `turn.started`, so by the time the fold
 * below reaches the message the event that classifies it has not arrived yet. The two are tied
 * together by `turnId` — each repair runs in a scope of its own — rather than by position,
 * which would be wrong on every window that opens mid-turn.
 */
function repairTurns(events: readonly StoredEvent[]): ReadonlySet<string> {
  const ids = new Set<string>();

  for (const event of events) {
    if (
      (event.type === "turn.started" && event.payload.source === "verification") ||
      (event.type === "user.message" && event.payload.repair !== undefined)
    ) {
      ids.add(event.turnId);
    }
  }

  return ids;
}

export function buildTranscript(
  events: readonly StoredEvent[],
  options: TranscriptOptions = {},
): TranscriptItem[] {
  const tests = new Map(foldAppTests(events).map((test) => [test.turnId, test]));
  const repairs = repairTurns(events);
  const items: TranscriptItem[] = [];
  /**
   * Steers, read across the whole log first: a steer is written by two processes, so its events can
   * land in either order, and where it is drawn depends on what became of it rather than on which
   * of its events came first.
   */
  const steersRead = new Set(
    events.flatMap((event) => (event.type === "steer.applied" ? [event.payload.steerId] : [])),
  );
  const prompted = new Set(
    events.flatMap((event) => (event.type === "user.message" ? [event.turnId] : [])),
  );
  const steersDrawn = new Set<string>();
  const steersWaiting = new Map<string, { key: number; text: string }>();
  /**
   * A verification came back red and no turn has opened since, so the next prompt is the one it
   * is about to write.
   *
   * The pass above cannot answer for the message that is on screen *right now*: the runtime
   * logs the repair prompt and then builds the turn's context — a sandbox file listing — before
   * the agent emits the `turn.started` that classifies it. For that second the log holds the
   * verifier's paragraph and nothing saying whose it is, and drawing it as the user's and then
   * correcting it is the one thing this treatment exists to prevent, live, on the demo.
   *
   * Deliberately the *narrowest* rule that covers the gap, because the source field exists
   * precisely so that nobody derives this by counting verifications back from a turn: red
   * checks, nothing opened since, and it is spent by the turn it was waiting for. Everything
   * that could mean no repair is coming — a green run, a job that closed, a turn that started —
   * puts it back, so the failure it cannot make is the expensive one: labelling somebody's own
   * words as the machine's.
   */
  let awaitingRepair = false;
  const stepsById = new Map<string, Step>();
  // Helpers are named per turn, so the turn is part of the key.
  const helpers = new Map<string, Step>();
  const plans = new Map<string, Extract<TranscriptItem, { kind: "plan" }>>();
  const openQuestions: Extract<TranscriptItem, { kind: "question" }>[] = [];
  const proposals = new Map<string, Extract<TranscriptItem, { kind: "proposed-plan" }>>();
  // Failed turns whose retry would approve a plan, checked against the whole log at the end.
  const approvalRetries: FailedTurnItem[] = [];
  // The step a `file.changed` belongs to: the last one opened that has not been answered yet.
  let openStep: Step | undefined;
  type RetryRequest = NapEventOf<"user.message">["payload"];
  const retryByTurn = new Map<string, RetryRequest | undefined>();
  const userTurnByJob = new Map<string, string>();
  // Only a known verification turn can inherit another turn's user request.
  let lastUserRequest: RetryRequest | undefined;

  for (const [eventIndex, event] of events.entries()) {
    // `seq` is unique per session and never reused, so it is a stable React key for free —
    // an index would re-key the whole list on every new event, springing collapsed steps open.
    const key = event.seq;

    switch (event.type) {
      case "test.recording":
        items.push(
          event.payload.recording.state === "unavailable"
            ? {
                kind: "notice",
                key,
                level: "warning",
                text: "Nap couldn't save this test recording.",
              }
            : {
                kind: "computer-recording",
                key,
                text:
                  event.payload.recording.state === "started"
                    ? "Started recording"
                    : "Stopped recording",
              },
        );
        break;
      case "test.annotation":
        break;
      case "test.completed": {
        const test = tests.get(event.turnId);
        if (test) items.push({ kind: "app-test", key, test });
        break;
      }
      case "test.started":
        items.push({
          kind: "notice",
          key,
          level: "info",
          text: `App test started: ${event.payload.objective}`,
        });
        break;
      case "computer.screenshot": {
        const step = stepsById.get(event.payload.toolCallId);
        if (step) step.frame = event;
        items.push({ kind: "computer-frame", key, frame: event });
        break;
      }
      case "computer.status": {
        const step =
          stepsById.get(event.payload.toolCallId) ??
          openOrphan(event, "computer", items, stepsById);
        step.desktop = { state: event.payload.state, at: event.createdAt };
        break;
      }
      case "compaction.started":
        if (event.payload.trigger === "manual") {
          retryByTurn.set(event.turnId, { text: "/compact" });
        }
        // The janitor can repeat an announcement after losing an append acknowledgement.
        if (items.some((item) => item.kind === "compaction" && item.id === event.payload.id)) break;
        items.push({
          kind: "compaction",
          key,
          id: event.payload.id,
          turnId: event.turnId,
          status: "running",
          trigger: event.payload.trigger,
          startedAt: event.createdAt,
        });
        break;
      case "compaction.completed":
      case "compaction.failed": {
        const index = items.findIndex(
          (item) => item.kind === "compaction" && item.id === event.payload.id,
        );
        const previous = items[index];
        const identity =
          previous?.kind === "compaction"
            ? {
                key: previous.key,
                trigger: previous.trigger,
                startedAt: previous.startedAt,
              }
            : { key, trigger: null, startedAt: null };
        const item: CompactionItem = {
          kind: "compaction",
          turnId: event.turnId,
          ...identity,
          ...(event.type === "compaction.completed"
            ? { status: "completed", finishedAt: event.createdAt, ...event.payload }
            : { status: "failed", finishedAt: event.createdAt, ...event.payload }),
        };
        if (index === -1) items.push(item);
        else items[index] = item;
        break;
      }
      case "user.message": {
        const from = repairs.has(event.turnId) || awaitingRepair ? "verifier" : "user";
        // Whatever the person says next answers what was asked, clicked or typed.
        if (from === "user")
          for (const question of openQuestions.splice(0)) question.answer = event.payload.text;
        items.push({
          kind: "message",
          key,
          from,
          text: event.payload.text,
          ...(event.payload.attachments === undefined
            ? {}
            : { attachments: event.payload.attachments }),
          ...(event.payload.plan === undefined ? {} : { plan: event.payload.plan }),
        });
        // Remembered for the turn this opens, so a failure downstream knows what to offer to
        // send again — and only when a person wrote it. Retrying means re-sending the request,
        // and a repair prompt is the verifier's account of a check that has not been re-run.
        if (event.payload.repair !== undefined) {
          const userTurn = userTurnByJob.get(event.payload.repair.jobId);
          retryByTurn.set(
            event.turnId,
            userTurn === undefined ? undefined : retryByTurn.get(userTurn),
          );
        } else if (from === "user") {
          lastUserRequest = event.payload;
          retryByTurn.set(event.turnId, event.payload);
        } else {
          retryByTurn.set(event.turnId, lastUserRequest);
        }
        break;
      }

      case "steer.received":
        // Drawn nowhere here: where it goes depends on what became of it, decided below.
        if (!steersWaiting.has(event.payload.steerId))
          steersWaiting.set(event.payload.steerId, { key, text: event.payload.text });
        break;

      case "steer.applied":
        if (steersDrawn.has(event.payload.steerId)) break;
        steersDrawn.add(event.payload.steerId);
        items.push({
          kind: "steer",
          key,
          steerId: event.payload.steerId,
          text: event.payload.text,
          status: "read",
        });
        break;

      case "steer.dropped": {
        // Read wins: a janitor that could not see the record of a read must not offer it back.
        if (steersRead.has(event.payload.steerId) || steersDrawn.has(event.payload.steerId)) break;
        steersDrawn.add(event.payload.steerId);
        // A steer joins only a turn in its own mode, so the turn says what it was.
        const plan = retryByTurn.get(event.turnId)?.plan;
        items.push({
          kind: "steer",
          key,
          steerId: event.payload.steerId,
          text: event.payload.text,
          status: "dropped",
          reason: event.payload.reason,
          ...(plan?.intent === "propose" ? { retryPlan: plan } : {}),
        });
        break;
      }

      case "agent.message": {
        // Same rule as reasoning below, and for the same reason: the answer is shown as it is
        // written, so it reaches the log as a run of events. They join into one paragraph
        // keyed to the `seq` it opened with. Only ever joined to the *agent's* own prose —
        // a step in between means the model said two things, and folding across one would
        // attribute the second half to before the tool ran.
        const open = items.at(-1);
        if (open?.kind === "message" && open.from === "agent") open.text += event.payload.text;
        else items.push({ kind: "message", key, from: "agent", text: event.payload.text });
        break;
      }

      case "agent.thinking": {
        // Reasoning is streamed and coalesced into phrase-sized events, so one thought is a
        // run of them. They join into a single passage rather than a paragraph each — and
        // the passage keeps the `seq` it opened with, because that key is what React renders
        // it under: keyed to the newest event instead, the element would remount on every
        // frame the model is thinking and restart the reveal of every word already on screen.
        const open = items.at(-1);
        if (open?.kind === "thinking") open.text += event.payload.text;
        else items.push({ kind: "thinking", key, text: event.payload.text });
        break;
      }

      case "tool.call": {
        const step: Step = {
          kind: "step",
          key,
          at: event.createdAt,
          toolCallId: event.payload.toolCallId,
          toolName: event.payload.toolName,
          input: event.payload.input,
          status: "running",
          output: "",
          streamed: "",
          files: [],
        };
        stepsById.set(step.toolCallId, step);
        openStep = step;
        items.push(step);
        break;
      }

      case "tool.result": {
        // A client that reconnected between a call and its result holds the second without
        // the first. Opening a step here is what keeps that tool visible at all — dropping it
        // would hide a failure from the one person who needs to see it.
        const step =
          stepsById.get(event.payload.toolCallId) ??
          openOrphan(event, event.payload.toolName, items, stepsById);
        step.status = event.payload.ok ? "ok" : "failed";
        step.output = event.payload.output;
        if (openStep === step) openStep = undefined;
        break;
      }

      case "command.output": {
        // Same reconnection case. `run_command` is the only tool that streams, so a chunk
        // whose call is missing can be attributed without guessing.
        const step =
          stepsById.get(event.payload.toolCallId) ??
          openOrphan(event, "run_command", items, stepsById);
        step.streamed += event.payload.chunk;
        break;
      }

      case "file.changed": {
        const change = toFileChange(event.payload);
        if (openStep === undefined) items.push({ kind: "files", key, files: [change] });
        else openStep.files.push(change);
        break;
      }

      case "plan.updated": {
        const existing = plans.get(event.turnId);
        if (existing !== undefined) items.splice(items.indexOf(existing), 1);
        const plan = existing ?? {
          kind: "plan" as const,
          key,
          turnId: event.turnId,
          items: [],
        };
        plan.items = event.payload.items;
        plans.set(event.turnId, plan);
        items.push(plan);
        break;
      }

      case "plan.proposed": {
        // A turn that proposed twice meant the second, and is drawn once, where it last proposed.
        const earlier = proposals.get(event.turnId);
        if (earlier !== undefined) items.splice(items.indexOf(earlier), 1);
        const proposal = {
          kind: "proposed-plan" as const,
          key,
          turnId: event.turnId,
          title: event.payload.title,
          plan: event.payload.plan,
          status: "drafting" as PlanStatus,
        };
        proposals.set(event.turnId, proposal);
        items.push(proposal);
        break;
      }

      case "agent.question": {
        const question = {
          kind: "question" as const,
          key,
          question: event.payload.question,
          options: event.payload.options,
          multiSelect: event.payload.multiSelect,
          answer: null,
          planning: retryByTurn.get(event.turnId)?.plan?.intent === "propose",
        };
        openQuestions.push(question);
        items.push(question);
        break;
      }

      case "subagent.started": {
        const step =
          stepsById.get(event.payload.toolCallId) ??
          openOrphan(event, "run_subagent", items, stepsById);
        step.helper = {
          subagentId: event.payload.subagentId,
          profile: event.payload.profile,
          task: event.payload.task,
          outcome: "running",
          summary: null,
          toolCalls: 0,
        };
        helpers.set(`${event.turnId}:${event.payload.subagentId}`, step);
        break;
      }

      case "subagent.completed": {
        const id = `${event.turnId}:${event.payload.subagentId}`;
        // A client that joined after the helper started still learns how it ended.
        const step =
          helpers.get(id) ??
          openOrphan(
            { ...event, payload: { toolCallId: event.payload.subagentId } },
            "run_subagent",
            items,
            stepsById,
          );
        step.status = event.payload.outcome === "completed" ? "ok" : "failed";
        step.helper = {
          subagentId: event.payload.subagentId,
          profile: step.helper?.profile ?? "explore",
          task: step.helper?.task ?? "",
          outcome: event.payload.outcome,
          summary: event.payload.summary,
          toolCalls: event.payload.toolCalls,
        };
        helpers.set(id, step);
        break;
      }

      case "preview.ready":
        // Every stop before this one is now history: the app is being served again. Marked
        // here rather than in a pass afterwards, because the rule is simply "a later ready
        // supersedes them", and this is the moment a later ready exists.
        for (const item of items) if (item.kind === "preview-stopped") item.superseded = true;
        items.push({ kind: "preview", key, url: event.payload.url, port: event.payload.port });
        break;

      // The preview pane says what to do about it; this is the chronology. An app that
      // disappeared because a sweep put the project away, or because somebody closed it in
      // another tab, is otherwise an app that vanished for no stated reason.
      // Every earlier stop is now history: the app is being served again, so a line saying it
      // is not would be contradicted by this very event — which itself draws nothing.
      case "preview.stopped":
        items.push({ kind: "preview-stopped", key, superseded: false });
        break;

      // Its own item rather than a message: the platform speaking is not the agent speaking,
      // and the two are rendered differently for exactly that reason.
      case "system.notice":
        items.push({ kind: "notice", key, level: event.payload.level, text: event.payload.text });
        break;

      case "turn.started":
        if (event.payload.source === "verification" && !retryByTurn.has(event.turnId)) {
          retryByTurn.set(event.turnId, lastUserRequest);
        }
        awaitingRepair = false;
        items.push({ kind: "turn-start", key, at: event.createdAt, source: event.payload.source });
        break;

      // Draws nothing — the workspace bar names the job's phase, and a failed check shows here
      // only as the repair turn it starts. Read here only for the flag above, which labels that
      // turn.
      case "verification.completed":
        awaitingRepair = event.payload.checks.some((check) => check.outcome === "failed");
        break;

      case "job.started":
        userTurnByJob.set(event.payload.jobId, event.turnId);
        break;

      // Whatever the checks last said, a job that has closed is prompting nothing further. Red
      // and out of attempts is exactly the case this exists for: the loop stops there, and the
      // next thing said is somebody typing.
      case "job.completed":
        awaitingRepair = false;
        break;

      case "turn.completed":
        items.push({
          kind: "turn-end",
          key,
          at: event.createdAt,
          outcome: "completed",
          durationMs: event.payload.durationMs,
          inputTokens: event.payload.usage.inputTokens,
          outputTokens: event.payload.usage.outputTokens,
          commitSha: event.payload.commitSha,
        });
        break;

      case "turn.failed": {
        let compactionFailureKey: number | undefined;
        const previous = events[eventIndex - 1];
        if (
          previous?.type === "compaction.failed" &&
          previous.turnId === event.turnId &&
          (previous.payload.message === event.payload.message ||
            (previous.payload.cancelled && event.payload.reason === "cancelled"))
        ) {
          compactionFailureKey = items.find(
            (item) => item.kind === "compaction" && item.id === previous.payload.id,
          )?.key;
        }
        for (const [index, item] of items.entries())
          if (
            item.kind === "compaction" &&
            item.turnId === event.turnId &&
            item.status === "running"
          ) {
            compactionFailureKey = item.key;
            items[index] = {
              ...item,
              status: "failed",
              finishedAt: event.createdAt,
              message: event.payload.message,
              cancelled: event.payload.reason === "cancelled",
              usage: null,
            };
          }

        const retry = retryByTurn.get(event.turnId);
        const failure: FailedTurnItem = {
          kind: "turn-end",
          key,
          at: event.createdAt,
          outcome: "failed",
          turnId: event.turnId,
          reason: event.payload.reason,
          message: event.payload.message,
          retryMessage: retry?.text,
          ...(compactionFailureKey === undefined ? {} : { compactionFailureKey }),
          ...(retry?.attachments === undefined ? {} : { retryAttachments: retry.attachments }),
          ...(retry?.plan === undefined ? {} : { retryPlan: retry.plan }),
        };
        items.push(failure);
        if (retry?.plan?.intent === "approve") approvalRetries.push(failure);
        break;
      }
    }
  }

  // Steers that have not landed anywhere, after everything: they are the newest thing said, and
  // drawing one at the point it was received would put it amid work the agent did without it.
  const idleThroughSeq = options.idleThroughSeq ?? 0;
  const running = inFlightTurn(events, idleThroughSeq) !== undefined;
  for (const [steerId, { key, text }] of steersWaiting) {
    if (steersDrawn.has(steerId) || prompted.has(steerId)) continue;
    items.push({
      kind: "steer",
      key,
      steerId,
      text,
      status: key <= idleThroughSeq ? "undelivered" : running ? "waiting" : "queued",
    });
  }

  // Settled by what came after, so decided once the whole log has been read.
  if (proposals.size > 0 || approvalRetries.length > 0) {
    const states = planStates(events);
    for (const proposal of proposals.values())
      proposal.status = states.get(proposal.turnId)?.status ?? proposal.status;
    // Retrying an approval is approving again, which the server accepts only while the plan
    // waits. A failed approving turn puts its plan back, so that retry works; a stale approval,
    // or a repair inside a job the plan already opened, could only be refused, and a control
    // that cannot help is worse than none.
    for (const failure of approvalRetries) {
      const plan = failure.retryPlan;
      if (plan?.intent !== "approve" || states.get(plan.planTurnId)?.status === "awaiting")
        continue;
      failure.retryMessage = undefined;
      delete failure.retryPlan;
      delete failure.retryAttachments;
    }
  }

  return items;
}

/**
 * A step for a tool whose `tool.call` this client never received, which happens when it
 * connected partway through the tool's execution. `input` is empty because it is genuinely
 * unknown — the alternative is inventing arguments the tool was never given.
 */
function openOrphan(
  event: { seq: number; createdAt: string; payload: { toolCallId: string } },
  toolName: ToolName,
  items: TranscriptItem[],
  stepsById: Map<string, Step>,
): Step {
  const step: Step = {
    kind: "step",
    key: event.seq,
    at: event.createdAt,
    toolCallId: event.payload.toolCallId,
    toolName,
    input: {},
    status: "running",
    output: "",
    streamed: "",
    files: [],
  };
  stepsById.set(step.toolCallId, step);
  items.push(step);
  return step;
}

function toFileChange(payload: NapEventOf<"file.changed">["payload"]): FileChange {
  let added = 0;
  let removed = 0;

  for (const line of payload.diff.split("\n")) {
    // `+++`/`---` are the file headers of a unified diff, not changed lines.
    if (line.startsWith("+") && !line.startsWith("+++")) added += 1;
    else if (line.startsWith("-") && !line.startsWith("---")) removed += 1;
  }

  return { path: payload.path, changeType: payload.changeType, diff: payload.diff, added, removed };
}
