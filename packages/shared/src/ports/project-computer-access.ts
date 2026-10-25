import { z } from "zod";
import type { Result } from "../result.ts";
import type { ScopeDrainProof } from "./desktop-input-transport.ts";

export const QueueLeaseIdentitySchema = z.strictObject({
  requestId: z.uuid(),
  owner: z.string().min(1).max(256),
});
export type QueueLeaseIdentity = z.infer<typeof QueueLeaseIdentitySchema>;
export const ComputerGrantBindingSchema = z.strictObject({
  projectId: z.uuid(),
  sessionId: z.uuid(),
  userId: z.string().min(1).max(256),
  sandboxId: z.string().min(1).max(256),
  revision: z.uuid(),
  expiresAt: z.int().nonnegative(),
});
export type ComputerGrantBinding = z.infer<typeof ComputerGrantBindingSchema>;
export const ComputerActorSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("owner"), binding: ComputerGrantBindingSchema }),
  z.strictObject({ kind: z.literal("turn"), lease: QueueLeaseIdentitySchema }),
]);
export const ComputerScopeIdentitySchema = z.strictObject({
  projectId: z.uuid(),
  sandboxId: z.string().min(1).max(256),
  scopeId: z.uuid(),
});
export type ComputerScopeIdentity = z.infer<typeof ComputerScopeIdentitySchema>;
export const ComputerReservationRequestSchema = ComputerScopeIdentitySchema.extend({
  actor: ComputerActorSchema,
});
export type ComputerReservationRequest = z.infer<typeof ComputerReservationRequestSchema>;
export const ComputerReservationSchema = ComputerReservationRequestSchema.extend({
  state: z.enum(["active", "recovering"]),
  createdAt: z.iso.datetime(),
  nextRecoveryAt: z.iso.datetime(),
});
export type ComputerReservation = z.infer<typeof ComputerReservationSchema>;
export type ComputerAdmissionError = {
  code: "busy" | "not_found" | "stale_grant" | "recovery_pending" | "unavailable";
};

/** Short committed operations. Physical work never runs inside a database transaction. */
export interface ProjectComputerAccess {
  read(request: {
    projectId: string;
    userId: string;
  }): Promise<Result<{ sandboxId: string | null; revision: string }, ComputerAdmissionError>>;
  reserve(
    request: ComputerReservationRequest,
  ): Promise<Result<ComputerReservation, ComputerAdmissionError>>;
  occupied(projectId: string): Promise<boolean>;
  markRecovering(scope: ComputerScopeIdentity): Promise<void>;
  clear(request: ComputerScopeIdentity & { proof: ScopeDrainProof }): Promise<boolean>;
  recoverable(limit: number): Promise<ComputerReservation[]>;
  defer(scope: ComputerScopeIdentity): Promise<void>;
}
