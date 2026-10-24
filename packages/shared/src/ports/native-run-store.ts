/** Private native execution journal. A start intent is never permission to replay a command. */
import { z } from "zod";
import { ExecutionTargetSchema } from "../execution-target.ts";
import type { PendingEvent, StoredEvent } from "./event-store.ts";
import type { SealedProviderCredentials } from "./provider-account-store.ts";
import type { ProcessExit } from "./sandbox-process.ts";

export type NativeRunHandle = { id: string; token: string };
export const NativeRunBindingSchema = z.strictObject({
  userId: z.uuid(),
  projectId: z.uuid(),
  sessionId: z.uuid(),
  requestId: z.uuid(),
  turnId: z.uuid(),
  target: ExecutionTargetSchema.options[1],
});
export type NativeRunBinding = z.infer<typeof NativeRunBindingSchema>;
export type NativeRunRecord = {
  binding: NativeRunBinding;
  cursor: number;
} & (
  | { phase: "intent" | "start_uncertain" }
  | { phase: "started"; nativeSessionId: string; receipt: SealedProviderCredentials }
  | { phase: "stopped"; proof: ProcessExit }
);
export type NativeDelivery = {
  sequence: number;
  /** SHA-256 of the original plaintext bytes, computed before sealing. */
  rawHash: string;
  raw: SealedProviderCredentials;
  events: PendingEvent[];
};
export type StoredNativeDelivery = Omit<NativeDelivery, "events"> & { events: StoredEvent[] };
export type NativeRunRefusal =
  | "denied"
  | "busy"
  | "already_exists"
  | "out_of_order"
  | "conflict"
  | "limit_exceeded";

export interface NativeRunStore {
  /** Derives ownership and target from a live queue lease. Does not launch any process. */
  begin(input: {
    id: string;
    requestId: string;
    workerId: string;
    turnId: string;
  }): Promise<
    | { kind: "created"; handle: NativeRunHandle; binding: NativeRunBinding }
    | { kind: NativeRunRefusal }
  >;
  started(
    handle: NativeRunHandle,
    input: { nativeSessionId: string; receipt: SealedProviderCredentials },
  ): Promise<boolean>;
  uncertain(handle: NativeRunHandle): Promise<boolean>;
  read(handle: NativeRunHandle): Promise<NativeRunRecord | null>;
  /** Raw frame, normalized events and cursor commit together before a supervisor ACK. */
  append(
    handle: NativeRunHandle,
    delivery: NativeDelivery,
  ): Promise<
    { kind: "appended" | "duplicate"; delivery: StoredNativeDelivery } | { kind: NativeRunRefusal }
  >;
  deliveries(
    handle: NativeRunHandle,
    afterSequence: number,
  ): Promise<StoredNativeDelivery[] | null>;
  /** Caller must verify the authenticated supervisor receipt; expiry alone never releases a fence. */
  stopped(handle: NativeRunHandle, proof: ProcessExit): Promise<boolean>;
}
