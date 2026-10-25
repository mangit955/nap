import { z } from "zod";
import type { Result } from "../result.ts";
import type {
  DesktopAction,
  DesktopError,
  DesktopObservation,
  SandboxDesktop,
} from "./sandbox-desktop.ts";

export const ScopeDrainProofSchema = z.strictObject({
  protocol: z.literal(2),
  kind: z.literal("scope_drained"),
  scopeId: z.uuid(),
  sandboxId: z.string().min(1).max(256),
});
export type ScopeDrainProof = z.infer<typeof ScopeDrainProofSchema>;
export type ScopedDesktopAction = {
  sandboxId: string;
  scopeId: string;
  action: DesktopAction;
  signal?: AbortSignal | undefined;
};

/** Raw input requires a single-use scope. Only the coordinator binds the public act method. */
export interface DesktopInputTransport extends Omit<SandboxDesktop, "act"> {
  /**
   * Whether this machine's driver takes scoped input and can drain it. Sends no input. `unknown`
   * when the machine could not be asked, which says nothing about how old its driver is.
   */
  supportsScopedInput(request: {
    sandboxId: string;
    signal?: AbortSignal | undefined;
  }): Promise<"yes" | "no" | "unknown">;
  observe(request: {
    sandboxId: string;
    action: DesktopAction;
    signal?: AbortSignal | undefined;
  }): Promise<Result<DesktopObservation, DesktopError>>;
  act(request: ScopedDesktopAction): Promise<Result<DesktopObservation, DesktopError>>;
  closeAndDrain(request: {
    sandboxId: string;
    scopeId: string;
    signal?: AbortSignal | undefined;
  }): Promise<Result<ScopeDrainProof, DesktopError>>;
}
