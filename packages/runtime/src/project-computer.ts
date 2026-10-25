import type { HumanComputerAction } from "@nap/shared/computer-access";
import {
  type DesktopInputTransport,
  ScopeDrainProofSchema,
} from "@nap/shared/ports/desktop-input-transport";
import {
  ABANDON_AFTER_MS,
  type ComputerAbandonError,
  type ComputerAdmissionError,
  type ComputerGrantBinding,
  type ComputerReservationRequest,
  type ComputerScopeIdentity,
  type ProjectComputerAccess,
  type QueueLeaseIdentity,
} from "@nap/shared/ports/project-computer-access";
import type { DesktopError, SandboxDesktop } from "@nap/shared/ports/sandbox-desktop";
import type { Result } from "@nap/shared/result";

const pending: DesktopError = {
  code: "completion_unknown",
  message: "Computer input recovery is pending. No action was replayed.",
};
const outdated: DesktopError = {
  code: "unavailable",
  message: "This computer predates safe input. Close and reopen the project to update it.",
};
const unanswered: DesktopError = {
  code: "unavailable",
  message: "Computer input is unavailable right now. No action was sent.",
};
// A reservation this old without a lease behind it is a stall, not input still in flight.
const STUCK_AFTER_MS = 60_000;
const noInput = new Set(["screenshot", "cursor_position", "read_dom", "console", "wait", "zoom"]);

async function bounded<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  ms: number,
  signal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let abort = () => {};
  const stopped = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new Error("Computer transport budget ended."));
    combined.addEventListener("abort", abort, { once: true });
    timeout = setTimeout(() => controller.abort(), ms);
  });
  try {
    combined.throwIfAborted();
    return await Promise.race([operation(combined), stopped]);
  } finally {
    clearTimeout(timeout);
    combined.removeEventListener("abort", abort);
  }
}
export type ComputerAttempt = {
  desktop: SandboxDesktop;
  close(): Promise<Result<void, { code: "recovery_pending" }>>;
  stopped(): boolean;
};

/** A committed row is the admission fence; local deadlines only bound this caller's work. */
export class ProjectComputer {
  readonly desktop: Omit<SandboxDesktop, "act">;
  readonly #access: ProjectComputerAccess;
  readonly #transport: DesktopInputTransport;
  readonly #now: () => number;
  // A machine's driver is fixed for its life, so a yes never needs asking twice.
  readonly #scoped = new Set<string>();
  constructor(options: {
    access: ProjectComputerAccess;
    transport: DesktopInputTransport;
    now?: () => number;
  }) {
    this.#access = options.access;
    this.#now = options.now ?? Date.now;
    this.#transport = options.transport;
    this.desktop = {
      start: (request) => options.transport.start(request),
      screenshot: (id, signal) => options.transport.screenshot(id, signal),
      streamCredentials: (id) => options.transport.streamCredentials(id),
    };
  }

  forTurn(request: {
    projectId: string;
    sandboxId: string;
    lease?: QueueLeaseIdentity | undefined;
  }): ComputerAttempt {
    return this.#attempt(
      request,
      request.lease ? { kind: "turn", lease: request.lease } : undefined,
    );
  }

  #attempt(
    identity: { projectId: string; sandboxId: string },
    actor: ComputerReservationRequest["actor"] | undefined,
  ): ComputerAttempt & { admissionError(): ComputerAdmissionError | undefined } {
    const scope: ComputerScopeIdentity = {
      projectId: identity.projectId,
      sandboxId: identity.sandboxId,
      scopeId: crypto.randomUUID(),
    };
    let reserved = false;
    let stopped = false;
    let closed = false;
    let admission: ComputerAdmissionError | undefined;
    let closeResult: Promise<Result<void, { code: "recovery_pending" }>> | undefined;
    const act: SandboxDesktop["act"] = async (sandboxId, action, signal) => {
      if (stopped || closed || sandboxId !== scope.sandboxId) return { ok: false, error: pending };
      if (noInput.has(action.action)) {
        try {
          return await bounded(
            (signal) => this.#transport.observe({ sandboxId, action, signal }),
            55_000,
            signal,
          );
        } catch {
          return {
            ok: false,
            error: { code: "unavailable", message: "Computer observation unavailable." },
          };
        }
      }
      if (!reserved) {
        if (!actor) {
          stopped = true;
          return { ok: false, error: pending };
        }
        // An older driver rejects the scoped act and can never drain, so a reservation against
        // it would block the project for good. Nothing was sent, so the attempt carries on.
        const supported = await this.#supportsScopedInput(sandboxId, signal);
        if (supported !== "yes") {
          admission = { code: "unavailable" };
          return { ok: false, error: supported === "no" ? outdated : unanswered };
        }
        if (stopped || closed) return { ok: false, error: pending };
        try {
          const result = await bounded(
            () => this.#access.reserve({ ...scope, actor }),
            5000,
            signal,
          );
          if (!result.ok) {
            admission = result.error;
            stopped = true;
            return { ok: false, error: pending };
          }
          reserved = true;
          if (closed || stopped) {
            await bounded(() => this.#access.markRecovering(scope), 1000).catch(() => undefined);
            return { ok: false, error: pending };
          }
        } catch {
          // Commit may have landed. Never dispatch after an uncertain acknowledgment.
          stopped = true;
          return { ok: false, error: pending };
        }
      }
      try {
        const result = await bounded(
          (signal) => this.#transport.act({ ...scope, action, signal }),
          55_000,
          signal,
        );
        if (result.ok) return result;
      } catch {
        /* A lost reply says nothing about physical completion. */
      }
      stopped = true;
      await bounded(() => this.#access.markRecovering(scope), 1000).catch(() => undefined);
      return { ok: false, error: pending };
    };
    const desktop: SandboxDesktop = { ...this.desktop, act };
    return {
      desktop,
      admissionError: () => admission,
      stopped: () => stopped,
      close: () =>
        (closeResult ??= (async (): Promise<Result<void, { code: "recovery_pending" }>> => {
          closed = true;
          if (!reserved)
            return stopped
              ? { ok: false, error: { code: "recovery_pending" } }
              : { ok: true, value: undefined };
          const clear = await this.#drain(scope);
          if (!clear) stopped = true;
          return clear
            ? { ok: true, value: undefined }
            : { ok: false, error: { code: "recovery_pending" } };
        })()),
    };
  }

  async ownerInput(request: {
    binding: ComputerGrantBinding;
    actions: HumanComputerAction[];
    signal?: AbortSignal | undefined;
  }): Promise<Result<{ applied: number }, ComputerAdmissionError & { applied: number }>> {
    const state = await bounded(
      () => this.#access.read(request.binding),
      5000,
      request.signal,
    ).catch(() => undefined);
    if (state === undefined) return { ok: false, error: { code: "unavailable", applied: 0 } };
    if (!state.ok) return { ok: false, error: { code: state.error.code, applied: 0 } };
    if (
      state.value.sandboxId !== request.binding.sandboxId ||
      state.value.revision !== request.binding.revision ||
      request.binding.expiresAt <= this.#now()
    )
      return { ok: false, error: { code: "stale_grant", applied: 0 } };
    const attempt = this.#attempt(request.binding, { kind: "owner", binding: request.binding });
    let applied = 0;
    let failure: ComputerAdmissionError | undefined;
    try {
      for (const action of request.actions) {
        if (request.binding.expiresAt <= this.#now() || request.signal?.aborted) {
          failure = { code: "unavailable" };
          break;
        }
        const result = await attempt.desktop.act(request.binding.sandboxId, action, request.signal);
        if (!result.ok) {
          failure = attempt.admissionError() ?? { code: "recovery_pending" };
          break;
        }
        applied++;
      }
    } finally {
      await attempt.close();
    }
    if (failure)
      return {
        ok: false,
        error: {
          code:
            attempt.admissionError()?.code ??
            (attempt.stopped() ? "recovery_pending" : failure.code),
          applied,
        },
      };
    return attempt.stopped()
      ? { ok: false, error: { code: "recovery_pending", applied } }
      : { ok: true, value: { applied } };
  }

  async #supportsScopedInput(
    sandboxId: string,
    signal?: AbortSignal,
  ): ReturnType<DesktopInputTransport["supportsScopedInput"]> {
    if (this.#scoped.has(sandboxId)) return "yes";
    const supported = await bounded(
      (signal) => this.#transport.supportsScopedInput({ sandboxId, signal }),
      15_000,
      signal,
    ).catch(() => "unknown" as const);
    if (supported === "yes") {
      if (this.#scoped.size >= 1000) this.#scoped.clear();
      this.#scoped.add(sandboxId);
    }
    return supported;
  }

  async #drain(scope: ComputerScopeIdentity): Promise<boolean> {
    try {
      const result = await bounded(
        (signal) => this.#transport.closeAndDrain({ ...scope, signal }),
        8000,
      );
      if (!result.ok) throw new Error("No drain proof.");
      const proof = ScopeDrainProofSchema.parse(result.value);
      if (proof.scopeId !== scope.scopeId || proof.sandboxId !== scope.sandboxId)
        throw new Error("Drain proof identity mismatch.");
      return await bounded(() => this.#access.clear({ ...scope, proof }), 1000);
    } catch {
      await bounded(() => this.#access.markRecovering(scope), 1000).catch(() => undefined);
      return false;
    }
  }

  /**
   * Whether this project is paused behind a reservation nobody is working on: no session holds a
   * lease, and the reservation is already being recovered or has stood for a minute.
   */
  async recovery(request: {
    projectId: string;
    userId: string;
  }): Promise<
    Result<{ stuck: false } | { stuck: true; abandonableAt: number }, { code: "not_found" }>
  > {
    const held = await bounded(() => this.#access.held(request), 5000);
    if (!held.ok) return held;
    const { reservation, busy } = held.value;
    if (!reservation || busy) return { ok: true, value: { stuck: false } };
    const createdAt = Date.parse(reservation.createdAt);
    if (reservation.state !== "recovering" && this.#now() - createdAt < STUCK_AFTER_MS)
      return { ok: true, value: { stuck: false } };
    return { ok: true, value: { stuck: true, abandonableAt: createdAt + ABANDON_AFTER_MS } };
  }

  /**
   * The owner's way out when a machine never proves its input drained: one more drain first,
   * which costs nothing if the machine has come back, and only then giving the machine up so the
   * next turn restores the last snapshot onto a fresh one. Never touches a scope a turn still
   * holds, since closing it would cut that turn's input mid-action.
   */
  async abandon(request: {
    projectId: string;
    userId: string;
  }): Promise<
    Result<
      { outcome: "clear" | "recovered" | "abandoned" },
      { code: ComputerAbandonError["code"]; abandonableAt?: number }
    >
  > {
    const held = await bounded(() => this.#access.held(request), 5000);
    if (!held.ok) return held;
    const { reservation, busy } = held.value;
    if (!reservation) return { ok: true, value: { outcome: "clear" } };
    if (busy) return { ok: false, error: { code: "busy" } };
    const scope: ComputerScopeIdentity = {
      projectId: reservation.projectId,
      sandboxId: reservation.sandboxId,
      scopeId: reservation.scopeId,
    };
    if (await this.#drain(scope)) return { ok: true, value: { outcome: "recovered" } };
    const abandoned = await bounded(
      () => this.#access.abandon({ ...scope, userId: request.userId }),
      5000,
    );
    if (abandoned.ok) return { ok: true, value: { outcome: "abandoned" } };
    return abandoned.error.code === "too_early"
      ? {
          ok: false,
          error: {
            code: "too_early",
            abandonableAt: Date.parse(reservation.createdAt) + ABANDON_AFTER_MS,
          },
        }
      : abandoned;
  }

  async recover(limit = 1): Promise<{ recovered: number; pending: number }> {
    const rows = await bounded(() => this.#access.recoverable(limit), 5000);
    let recovered = 0;
    for (const row of rows) {
      // Defer before RPC, so a permanently unreachable scope cannot monopolize the scan.
      await bounded(() => this.#access.defer(row), 1000);
      await bounded(() => this.#access.markRecovering(row), 1000);
      if (await this.#drain(row)) recovered++;
      else await bounded(() => this.#access.defer(row), 1000);
    }
    return { recovered, pending: rows.length - recovered };
  }
}
