import type { DesktopInputTransport } from "@nap/shared/ports/desktop-input-transport";
import {
  DESKTOP_HEIGHT,
  DESKTOP_WIDTH,
  type DesktopAction,
  type DesktopError,
  type DesktopFrame,
  type DesktopObservation,
  type DesktopStart,
  type SandboxDesktop,
} from "@nap/shared/ports/sandbox-desktop";
import type { Result } from "@nap/shared/result";

/** Scripted pixels and observations, with real ordering and sandbox isolation. No browser runs. */
export class FakeSandboxDesktop implements SandboxDesktop {
  readonly starts: Omit<DesktopStart, "signal">[] = [];
  readonly actions: { sandboxId: string; action: DesktopAction }[] = [];
  readonly screenshots: string[] = [];
  readonly #cursors = new Map<string, [number, number]>();
  readonly #observations: DesktopObservation[] = [];
  #frame: DesktopFrame;
  #failure: DesktopError | undefined;
  readonly #closedScopes = new Set<string>();
  readonly #pendingScopes = new Map<string, number>();
  readonly transport: DesktopInputTransport = {
    start: (request) => this.start(request),
    screenshot: (id, signal) => this.screenshot(id, signal),
    streamCredentials: (id) => this.streamCredentials(id),
    observe: ({ sandboxId, action, signal }) => this.act(sandboxId, action, signal),
    act: async ({ sandboxId, scopeId, action, signal }) => {
      if (this.#closedScopes.has(scopeId))
        return { ok: false, error: { code: "completion_unknown", message: "Scope closed." } };
      this.#pendingScopes.set(scopeId, (this.#pendingScopes.get(scopeId) ?? 0) + 1);
      try {
        return await this.act(sandboxId, action, signal);
      } finally {
        this.#pendingScopes.set(scopeId, (this.#pendingScopes.get(scopeId) ?? 1) - 1);
      }
    },
    closeAndDrain: async ({ sandboxId, scopeId }) => {
      this.#closedScopes.add(scopeId);
      if (this.#failure) return { ok: false, error: this.#failure };
      if ((this.#pendingScopes.get(scopeId) ?? 0) > 0)
        return { ok: false, error: { code: "timeout", message: "Input remains pending." } };
      return { ok: true, value: { protocol: 2, kind: "scope_drained", sandboxId, scopeId } };
    },
  };

  constructor(frame: DesktopFrame) {
    this.#frame = structuredClone(frame);
  }

  failWith(error: DesktopError | undefined): this {
    this.#failure = error;
    return this;
  }
  returning(frame: DesktopFrame): this {
    this.#frame = structuredClone(frame);
    return this;
  }
  observe(observation: DesktopObservation): this {
    this.#observations.push(structuredClone(observation));
    return this;
  }

  async start(
    options: DesktopStart,
  ): Promise<Result<{ width: number; height: number }, DesktopError>> {
    const failure = this.#blocked(options.signal);
    if (failure) return { ok: false, error: failure };
    if (!this.#cursors.has(options.sandboxId)) {
      this.starts.push({ sandboxId: options.sandboxId, devServerUrl: options.devServerUrl });
      this.#cursors.set(options.sandboxId, [0, 0]);
    }
    return { ok: true, value: { width: DESKTOP_WIDTH, height: DESKTOP_HEIGHT } };
  }

  async screenshot(
    sandboxId: string,
    signal?: AbortSignal,
  ): Promise<Result<DesktopFrame, DesktopError>> {
    const failure = this.#blocked(signal, sandboxId);
    if (failure) return { ok: false, error: failure };
    this.screenshots.push(sandboxId);
    return { ok: true, value: structuredClone(this.#frame) };
  }

  async act(
    sandboxId: string,
    action: DesktopAction,
    signal?: AbortSignal,
  ): Promise<Result<DesktopObservation, DesktopError>> {
    const failure = this.#blocked(signal, sandboxId);
    if (failure) return { ok: false, error: failure };
    this.actions.push({ sandboxId, action: structuredClone(action) });
    if ("coordinate" in action && action.coordinate)
      this.#cursors.set(sandboxId, [...action.coordinate]);
    if (action.action === "cursor_position")
      return {
        ok: true,
        value: { kind: "cursor", coordinate: [...(this.#cursors.get(sandboxId) ?? [0, 0])] },
      };
    if (action.action === "read_dom" || action.action === "console") {
      const observation = this.#observations.shift();
      if (!observation)
        throw new Error(`FakeSandboxDesktop: unscripted ${action.action} observation`);
      return { ok: true, value: structuredClone(observation) };
    }
    return { ok: true, value: { kind: "none" } };
  }

  async streamCredentials(
    sandboxId: string,
  ): Promise<Result<{ url: string; password: string }, DesktopError>> {
    const failure = this.#blocked(undefined, sandboxId);
    if (failure) return { ok: false, error: failure };
    return {
      ok: true,
      value: {
        url: `wss://desktop.invalid/${encodeURIComponent(sandboxId)}`,
        password: "fake-desktop-password",
      },
    };
  }

  #blocked(signal?: AbortSignal, sandboxId?: string): DesktopError | undefined {
    if (signal?.aborted) return { code: "cancelled", message: "Desktop operation cancelled." };
    if (this.#failure) return { ...this.#failure };
    if (sandboxId !== undefined && !this.#cursors.has(sandboxId))
      return { code: "not_started", message: "Desktop has not started." };
    return undefined;
  }
}
