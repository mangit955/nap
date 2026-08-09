/**
 * The request parameters of the file-browsing routes.
 *
 * The path is the security-relevant one: it arrives from a browser and is handed to a
 * filesystem inside someone's sandbox. Anything that could name a file outside the project —
 * an absolute path, a `..` segment, a null byte splitting the name — is refused here rather
 * than sanitized, because a rejected request is auditable and a rewritten one is not.
 * `ProjectPathSchema` is where the rule lives, so the browser refuses to *display* what this
 * refuses to serve.
 *
 * Failure is a value, matching `ws/query.ts`: a bad parameter is an ordinary thing for a
 * client to send, and the route answers it with a 400 rather than an exception.
 */

import { TEMPLATE_WORKDIR } from "@nap/sandbox/template";
import { ProjectPathSchema } from "@nap/shared/files-protocol";
import type { Result } from "@nap/shared/result";
import { z } from "zod";

export type ResolvedPath = {
  /** What the client sent, unchanged — it is the key the tree and the viewer share. */
  relative: string;
  /** Where that file lives in the sandbox. */
  absolute: string;
};

type ParamError = { message: string };

function fail(issues: z.ZodError): Result<never, ParamError> {
  return { ok: false, error: { message: issues.issues.map((issue) => issue.message).join("; ") } };
}

export function parseSessionId(raw: string | undefined): Result<string, ParamError> {
  const parsed = z.uuid("sessionId must be a uuid").safeParse(raw);
  return parsed.success ? { ok: true, value: parsed.data } : fail(parsed.error);
}

export function parseProjectPath(raw: string | null): Result<ResolvedPath, ParamError> {
  const parsed = ProjectPathSchema.safeParse(raw ?? undefined);
  if (!parsed.success) return fail(parsed.error);

  return {
    ok: true,
    value: { relative: parsed.data, absolute: `${TEMPLATE_WORKDIR}/${parsed.data}` },
  };
}
