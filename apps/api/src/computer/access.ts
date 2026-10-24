import { createHmac, timingSafeEqual } from "node:crypto";
import { ComputerInputSchema, ComputerStreamSchema } from "@nap/shared/computer-access";
import type { ProjectComputerAccess } from "@nap/shared/ports/project-computer-access";
import type { SandboxDesktop } from "@nap/shared/ports/sandbox-desktop";
import type { SessionRecord, SessionStore } from "@nap/shared/ports/session-store";
import type { Context, Hono } from "hono";
import { z } from "zod";
import { findOwnedSession } from "../auth/owned-session.ts";
import type { AuthVariables } from "../auth/require-user.ts";

export type ComputerAccessDeps = {
  sessions: SessionStore;
  desktop: SandboxDesktop;
  access: ProjectComputerAccess;
  /** The already-required BETTER_AUTH_SECRET, injected by composition. */
  secret: string;
  now?: () => number;
  previewPort?: (session: SessionRecord) => Promise<number | null>;
};
const PortSchema = z.int().min(1).max(65535);
const unavailable = { error: "Desktop is unavailable.", code: "desktop_unavailable" };
const privateHeaders = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
};

export function registerComputerAccessRoutes(
  app: Hono<{ Variables: AuthVariables }>,
  deps: ComputerAccessDeps,
  webOrigin?: string,
): void {
  const now = deps.now ?? Date.now;
  const key = createHmac("sha256", deps.secret).update("nap:computer-control:key:v1").digest();
  const mac = (payload: string) =>
    createHmac("sha256", key).update(`nap-computer-v1.${payload}`).digest();
  const sign = (claims: z.infer<typeof ClaimsSchema>) => {
    const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
    return `nap-computer-v1.${payload}.${mac(payload).toString("base64url")}`;
  };
  const verify = (token: string) => {
    const parts = token.split(".");
    const [prefix, payload, signature] = parts;
    if (
      parts.length !== 3 ||
      prefix !== "nap-computer-v1" ||
      !payload ||
      !signature ||
      !/^[A-Za-z0-9_-]+$/.test(payload) ||
      !/^[A-Za-z0-9_-]{43}$/.test(signature)
    )
      return null;
    const supplied = Buffer.from(signature, "base64url");
    const expected = mac(payload);
    if (
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected) ||
      supplied.toString("base64url") !== signature
    )
      return null;
    try {
      const parsed = ClaimsSchema.safeParse(
        JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
      );
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  };

  const control = (issueGrant: boolean) => async (c: Context<{ Variables: AuthVariables }>) => {
    setPrivateHeaders(c);
    const owned = await findOwnedSession(deps.sessions, c.req.param("sessionId"), c.get("userId"));
    if (!owned.ok) return c.json({ error: owned.error.message }, owned.error.status);
    if (issueGrant) {
      const rejected = rejectCrossSiteWrite(c, webOrigin);
      if (rejected) return rejected;
      if (!z.strictObject({}).safeParse(await readJson(c.req.raw)).success)
        return c.json({ error: "Invalid control request." }, 400);
    }
    try {
      const result = await deps.access.withIdleProject(
        { projectId: owned.value.projectId, userId: c.get("userId") },
        async (computer) => {
          if (!computer.sandboxId || !z.uuid().safeParse(computer.revision).success)
            return c.json(unavailable, 503);
          if (!issueGrant) return c.json({ available: true });
          const expiresAt = now() + 60_000;
          return c.json({
            grant: sign({
              ...owned.value,
              sandboxId: computer.sandboxId,
              revision: computer.revision,
              expiresAt,
            }),
            expiresAt,
          });
        },
      );
      return result.ok ? result.value : guardFailure(c, result.error.code);
    } catch {
      return c.json(unavailable, 503);
    }
  };
  app.get("/sessions/:sessionId/computer/control", control(false));
  app.post("/sessions/:sessionId/computer/control", control(true));

  app.post("/sessions/:sessionId/computer/input", async (c) => {
    setPrivateHeaders(c);
    const owned = await findOwnedSession(deps.sessions, c.req.param("sessionId"), c.get("userId"));
    if (!owned.ok) return c.json({ error: owned.error.message }, owned.error.status);
    const rejected = rejectCrossSiteWrite(c, webOrigin);
    if (rejected) return rejected;
    const body = ComputerInputSchema.safeParse(await readJson(c.req.raw));
    if (!body.success) return c.json({ error: "Invalid computer input." }, 400);
    let applied = 0;
    try {
      const result = await deps.access.withIdleProject(
        { projectId: owned.value.projectId, userId: c.get("userId") },
        async (computer) => {
          // Both the MAC and every binding are checked under the authoritative project lock.
          const claims = verify(body.data.grant);
          if (
            !claims ||
            claims.expiresAt <= now() ||
            claims.revision !== computer.revision ||
            claims.userId !== c.get("userId") ||
            claims.projectId !== owned.value.projectId ||
            claims.sessionId !== owned.value.sessionId ||
            claims.sandboxId !== computer.sandboxId ||
            claims.sandboxId !== owned.value.sandboxId
          )
            return c.json(
              { error: "Control grant is stale. Take control again.", code: "stale_grant" },
              409,
            );
          const signal = AbortSignal.any([AbortSignal.timeout(5000), c.req.raw.signal]);
          for (const action of body.data.actions) {
            if (signal.aborted || claims.expiresAt <= now())
              return c.json({ ...unavailable, applied }, 503);
            // Await the adapter even after abort. A race would unlock while physical input runs.
            const acted = await deps.desktop.act(claims.sandboxId, action, signal);
            if (!acted.ok) return c.json({ ...unavailable, applied }, 503);
            applied++;
            if (signal.aborted) return c.json({ ...unavailable, applied }, 503);
          }
          return c.json({ applied });
        },
      );
      return result.ok ? result.value : guardFailure(c, result.error.code);
    } catch {
      return c.json({ ...unavailable, applied }, 503);
    }
  });
  app.get("/sessions/:sessionId/computer/stream", async (c) => {
    setPrivateHeaders(c);
    const owned = await findOwnedSession(deps.sessions, c.req.param("sessionId"), c.get("userId"));
    if (!owned.ok) return c.json({ error: owned.error.message }, owned.error.status);
    const session = owned.value;
    if (!session.sandboxId) return c.json(unavailable, 503);
    try {
      const port = PortSchema.safeParse(await (deps.previewPort?.(session) ?? 5173));
      if (!port.success) return c.json(unavailable, 503);
      const started = await deps.desktop.start({
        sandboxId: session.sandboxId,
        devServerUrl: `http://localhost:${port.data}`,
        signal: c.req.raw.signal,
      });
      if (c.req.raw.signal.aborted || !started.ok) return c.json(unavailable, 503);
      const credentials = await deps.desktop.streamCredentials(session.sandboxId);
      if (!credentials.ok) return c.json(unavailable, 503);
      const stream = ComputerStreamSchema.safeParse({ ...credentials.value, ...started.value });
      return stream.success ? c.json(stream.data) : c.json(unavailable, 503);
    } catch {
      // Adapter exceptions can contain transport credentials. Never pass them to the app logger.
      return c.json(unavailable, 503);
    }
  });
}

const ClaimsSchema = z.strictObject({
  userId: z.string().min(1).max(256),
  projectId: z.uuid(),
  sessionId: z.uuid(),
  sandboxId: z.string().min(1).max(256),
  revision: z.uuid(),
  expiresAt: z.int().nonnegative(),
});

type AccessContext = Context<{ Variables: AuthVariables }>;
function setPrivateHeaders(c: AccessContext): void {
  for (const [name, value] of Object.entries(privateHeaders)) c.header(name, value);
}
function guardFailure(c: AccessContext, code: "busy" | "not_found") {
  return code === "not_found"
    ? c.json({ error: "no such session" }, 404)
    : c.json({ error: "A turn is running in this project.", code: "busy" }, 409);
}
function rejectCrossSiteWrite(c: AccessContext, webOrigin?: string) {
  const origin = c.req.header("origin");
  if (
    origin !== undefined
      ? origin !== new URL(c.req.url).origin && origin !== webOrigin
      : c.req.header("sec-fetch-site") === "cross-site"
  )
    return c.json({ error: "Untrusted request origin." }, 403);
  if (c.req.header("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json")
    return c.json({ error: "JSON content type required." }, 415);
  return null;
}

/** Bound the encoded body too, including escaped JSON, before parsing untrusted input. */
async function readJson(request: Request): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) return undefined;
  try {
    const decoder = new TextDecoder();
    let size = 0;
    let text = "";
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 256 * 1024) {
        await reader.cancel();
        return undefined;
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } catch {
    return undefined;
  } finally {
    reader.releaseLock();
  }
}
