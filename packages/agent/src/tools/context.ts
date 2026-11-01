/**
 * What a tool handler is given and what it gives back, plus the helpers every handler shares.
 *
 * Separate from `execute.ts` so a handler module can import these without importing the
 * dispatcher that imports it.
 */

import type { SubagentProfile } from "@nap/shared/agent-plan";
import type { NapEvent, NapEventOf, ToolName } from "@nap/shared/events";
import type { AgentTurnRequest } from "@nap/shared/ports/agent-service";
import type { DistributiveOmit } from "@nap/shared/ports/event-store";
import type { LLMObservationBlock, LLMToolCall } from "@nap/shared/ports/llm-provider";
import type { SandboxError, SandboxManager } from "@nap/shared/ports/sandbox-manager";
import type { FileLedger } from "./ledger.ts";

/**
 * Starts and collects delegated work. Implemented by the agent service, which owns the model;
 * a tool only knows how to ask.
 */
export interface SubagentRunner {
  /** Runs to the end and reports. Never throws: a helper that failed says so in its report. */
  run(
    request: {
      toolCallId: string;
      profile: SubagentProfile;
      task: string;
    },
    emit?: ToolContext["emit"],
  ): Promise<ToolOutcome>;
  /** Starts it and returns the id `collect` takes. */
  start(request: { toolCallId: string; profile: SubagentProfile; task: string }): string;
  /** Waits for a started helper's report, or says there is no such helper. */
  collect(subagentId: string): Promise<ToolOutcome>;
}

/** Everything a tool needs beyond its own arguments. */
export type ToolContext = {
  sessionId: string;
  turnId: string;
  sandboxId: string;
  sandbox: SandboxManager;
  computer?: AgentTurnRequest["computer"];
  signal?: AbortSignal | undefined;
  testMode?: boolean;
  /**
   * The tools this turn was offered. A call naming anything else is refused, even when the name
   * is real: an app test that invents `write_file` must not get to run it. Absent offers all.
   */
  offered?: ReadonlySet<ToolName> | undefined;
  /** What this turn has read and written, for the rule that a file is read before it changes. */
  ledger?: FileLedger | undefined;
  /** Helpers must finish their commands before handing control back to the parent. */
  backgroundShells?: boolean;
  subagents?: SubagentRunner | undefined;
  /** Receives each event as it happens, without a `seq`. */
  emit: (event: DistributiveOmit<NapEvent, "seq">) => void;
  /** Injected so a test can assert on whole events rather than on everything but the clock. */
  now?: () => string;
};

/** What the model is told. `ok: false` becomes `is_error` on the tool result block. */
export type ToolOutcome = {
  output: string;
  content?: LLMObservationBlock[];
} & (
  | {
      ok: true;
      stop?: never;
      /** The turn ends once this batch is answered — a question waits for the person. */
      endsTurn?: true;
    }
  | { ok: false; stop?: "computer_unsettled"; endsTurn?: never }
);

export type ToolHandler<Args> = (
  args: Args,
  call: LLMToolCall,
  ctx: ToolContext,
) => Promise<ToolOutcome>;

type Payload<T extends NapEvent["type"]> = NapEventOf<T>["payload"];

/**
 * Stamps an event with the envelope every event carries.
 *
 * Written as a generic over the discriminated union so that `type` and `payload` stay
 * correlated — the pair is the whole contract, and a helper that decoupled them would let
 * a `tool.call` carry a `file.changed` body.
 */
export function emit<T extends NapEvent["type"]>(
  ctx: ToolContext,
  event: { type: T; payload: Payload<T> },
): void {
  ctx.emit({
    ...event,
    sessionId: ctx.sessionId,
    turnId: ctx.turnId,
    createdAt: (ctx.now ?? defaultNow)(),
  } as DistributiveOmit<NapEvent, "seq">);
}

const defaultNow = (): string => new Date().toISOString();

export function failed(error: SandboxError): ToolOutcome {
  return { ok: false, output: `${error.code}: ${error.message}` };
}
