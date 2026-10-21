import type { SessionStarted } from "../session-start-protocol.ts";
import type { ImportRepository } from "./github-store.ts";
import type { EnqueueTurnRequest } from "./turn-queue.ts";

export type StartReceipt = { fingerprint: string; result: SessionStarted | null };
export type AdmittedSessionStart = {
  userId: string;
  operationId: string;
  fingerprint: string;
  name: string;
  source: { kind: "template" } | { kind: "github"; import: ImportRepository };
  request: Pick<EnqueueTurnRequest, "kind" | "message" | "model" | "billsToUser" | "attachments">;
};
export type StartResult =
  | ({ kind: "created" } & SessionStarted)
  | { kind: "conflict" }
  | { kind: "deleted" }
  | { kind: "access_changed" };

export interface SessionStartStore {
  find(userId: string, operationId: string): Promise<StartReceipt | null>;
  /** Creation, repository binding, queue admission and receipt commit together. */
  start(input: AdmittedSessionStart): Promise<StartResult>;
}
