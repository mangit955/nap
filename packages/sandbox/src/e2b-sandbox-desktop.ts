import type {
  DesktopAction,
  DesktopError,
  DesktopFrame,
  DesktopObservation,
  DesktopStart,
  SandboxDesktop,
} from "@nap/shared/ports/sandbox-desktop";
import type { SandboxManager } from "@nap/shared/ports/sandbox-manager";
import type { Result } from "@nap/shared/result";
import type { z } from "zod";
import {
  DESKTOP_DRIVER,
  DESKTOP_STATE,
  DESKTOP_STREAM_PORT,
  DesktopImageSchema,
  DesktopObservationSchema,
  DesktopPasswordSchema,
  DesktopReplySchema,
  type DesktopRequest,
  DesktopSizeSchema,
} from "./desktop-protocol.ts";

const unavailable: DesktopError = {
  code: "unavailable",
  message: "Nap's computer is unavailable.",
};
const cancelled: DesktopError = { code: "cancelled", message: "Desktop operation cancelled." };

/** Keeps process commands and private transport data behind the existing sandbox exec port. */
export class E2BSandboxDesktop implements SandboxDesktop {
  readonly #sandbox: SandboxManager;
  constructor(options: { sandbox: SandboxManager }) {
    this.#sandbox = options.sandbox;
  }

  async start(
    options: DesktopStart,
  ): Promise<Result<{ width: number; height: number }, DesktopError>> {
    let port: number;
    try {
      const url = new URL(options.devServerUrl);
      port = Number(url.port || "80");
      if (
        url.protocol !== "http:" ||
        !["localhost", "127.0.0.1"].includes(url.hostname) ||
        url.username ||
        url.password ||
        url.pathname !== "/" ||
        url.search ||
        url.hash ||
        !Number.isInteger(port) ||
        port < 1 ||
        port > 65535
      )
        return { ok: false, error: unavailable };
    } catch {
      return { ok: false, error: unavailable };
    }
    return this.#request(
      options.sandboxId,
      { id: crypto.randomUUID(), op: "start", port },
      DesktopSizeSchema,
      options.signal,
    );
  }

  async screenshot(
    sandboxId: string,
    signal?: AbortSignal,
  ): Promise<Result<DesktopFrame, DesktopError>> {
    const result = await this.#request(
      sandboxId,
      { id: crypto.randomUUID(), op: "screenshot" },
      DesktopImageSchema,
      signal,
    );
    if (!result.ok) return result;
    const bytes = Buffer.from(result.value.data, "base64");
    if (
      bytes[0] !== 0xff ||
      bytes[1] !== 0xd8 ||
      bytes[2] !== 0xff ||
      bytes.at(-2) !== 0xff ||
      bytes.at(-1) !== 0xd9
    )
      return { ok: false, error: unavailable };
    return {
      ok: true,
      value: {
        bytes: Uint8Array.from(bytes),
        width: result.value.width,
        height: result.value.height,
      },
    };
  }

  async act(
    sandboxId: string,
    action: DesktopAction,
    signal?: AbortSignal,
  ): Promise<Result<DesktopObservation, DesktopError>> {
    return this.#request(
      sandboxId,
      { id: crypto.randomUUID(), op: "act", action },
      DesktopObservationSchema,
      signal,
    );
  }

  async streamCredentials(
    sandboxId: string,
  ): Promise<Result<{ url: string; password: string }, DesktopError>> {
    const result = await this.#request(
      sandboxId,
      { id: crypto.randomUUID(), op: "credentials" },
      DesktopPasswordSchema,
    );
    if (!result.ok) return result;
    const host = await this.#sandbox.getPreviewUrl(sandboxId, DESKTOP_STREAM_PORT);
    if (!host.ok) return { ok: false, error: unavailable };
    try {
      const url = new URL(host.value);
      if (url.protocol !== "https:" && url.protocol !== "http:")
        return { ok: false, error: unavailable };
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      url.pathname = "/websockify";
      url.search = "";
      url.hash = "";
      return { ok: true, value: { url: url.toString(), password: result.value.password } };
    } catch {
      return { ok: false, error: unavailable };
    }
  }

  #command(request: DesktopRequest): string {
    const data = Buffer.from(JSON.stringify(request)).toString("base64");
    const invoke = `node ${DESKTOP_DRIVER} '${data}'`;
    return request.op === "cancel"
      ? `timeout 5s ${invoke}`
      : `install -d -m700 ${DESKTOP_STATE} && timeout --signal=TERM --kill-after=2 55s flock --close --wait 5 ${DESKTOP_STATE}/action.lock ${invoke}`;
  }

  async #request<T>(
    sandboxId: string,
    request: DesktopRequest,
    schema: z.ZodType<T>,
    signal?: AbortSignal,
  ): Promise<Result<T, DesktopError>> {
    if (signal?.aborted) return { ok: false, error: cancelled };
    let cleanup: Promise<unknown> | undefined;
    const abort = () => {
      cleanup = this.#sandbox
        .exec(sandboxId, this.#command({ op: "cancel", id: request.id }))
        .catch(() => undefined);
    };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const result = await this.#sandbox.exec(sandboxId, this.#command(request));
      if (signal?.aborted) {
        await cleanup;
        return { ok: false, error: cancelled };
      }
      if (!result.ok)
        return {
          ok: false,
          error: {
            ...unavailable,
            code: result.error.code === "timeout" ? "timeout" : "unavailable",
          },
        };
      const failure: DesktopError = {
        ...unavailable,
        code: result.value.exitCode === 124 ? "timeout" : "unavailable",
      };
      if (result.value.stdout.length > 3_200_000) return { ok: false, error: failure };
      let json: unknown;
      try {
        json = JSON.parse(result.value.stdout);
      } catch {
        return { ok: false, error: failure };
      }
      const reply = DesktopReplySchema.safeParse(json);
      if (!reply.success) return { ok: false, error: failure };
      if (!reply.data.ok) return reply.data;
      if (result.value.exitCode !== 0) return { ok: false, error: failure };
      const value = schema.safeParse(reply.data.value);
      return value.success ? { ok: true, value: value.data } : { ok: false, error: unavailable };
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }
}
