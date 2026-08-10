/**
 * Browsing the project's files.
 *
 * The browser cannot hold a `SandboxManager` — the execution plane is reachable only from the
 * server — so the file tree and its viewer are two reads over HTTP rather than a client-side
 * concern. Both are read-only: nothing here writes to a sandbox, and the agent remains the
 * only thing that changes a project.
 *
 * The listing is one bounded walk per request rather than a call per opened directory. A tree
 * that had to fetch each folder as it opened could not highlight a file three levels down
 * without a chain of round trips, and highlighting what just changed is the point of showing
 * the tree at all.
 *
 * A sandbox failure is reported by kind, because the three cases mean different things to
 * whoever is looking at the pane: a file that is not there, a sandbox that has gone away and
 * will come back with the next turn, and something wrong on our side.
 */

import { listProjectFiles } from "@nap/sandbox/project-files";
import type { FileContent, FileListing } from "@nap/shared/files-protocol";
import type { SandboxError, SandboxManager } from "@nap/shared/ports/sandbox-manager";
import type { SessionStore } from "@nap/shared/ports/session-store";
import type { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { findOwnedSession } from "../auth/owned-session.ts";
import type { AuthVariables } from "../auth/require-user.ts";
import { parseProjectPath } from "./params.ts";

/**
 * How much of a file is worth sending. Generated projects hold the occasional huge file —
 * a lockfile, a data blob a model pasted in — and shipping megabytes to render in a pane
 * nobody will read that far into costs the user their bandwidth and the browser its frame
 * rate. The viewer says what is missing rather than pretending the file ends here.
 */
export const MAX_FILE_BYTES = 128 * 1024;

export type FileRouteDeps = {
  sessions: SessionStore;
  sandbox: SandboxManager;
};

/** Which kind of failure a sandbox error is, from the point of view of someone browsing. */
function statusFor(error: SandboxError): ContentfulStatusCode {
  switch (error.code) {
    case "file_not_found":
      return 404;
    // The sandbox is asleep, destroyed or unreachable. All three end the same way for a
    // reader — there is nothing to show right now, and the next turn will bring it back.
    case "not_found":
    case "destroyed":
    case "unavailable":
    case "timeout":
      return 503;
    default:
      return 500;
  }
}

export function registerFileRoutes(
  app: Hono<{ Variables: AuthVariables }>,
  deps: FileRouteDeps,
): void {
  app.get("/sessions/:sessionId/files", async (c) => {
    const found = await findOwnedSession(deps.sessions, c.req.param("sessionId"), c.get("userId"));
    if (!found.ok) return c.json({ error: found.error.message }, found.error.status);
    const session = found.value;

    // No sandbox is the state every project starts in, and it is not a failure: the first
    // turn creates one. Saying so explicitly lets the pane invite rather than apologize.
    if (session.sandboxId === null) {
      return c.json({ ready: false, files: [], truncated: false } satisfies FileListing);
    }

    const listed = await listProjectFiles(deps.sandbox, session.sandboxId);
    if (!listed.ok) return c.json({ error: listed.error.message }, statusFor(listed.error));

    return c.json({
      ready: true,
      files: listed.value.paths,
      truncated: listed.value.truncated,
    } satisfies FileListing);
  });

  app.get("/sessions/:sessionId/file", async (c) => {
    const found = await findOwnedSession(deps.sessions, c.req.param("sessionId"), c.get("userId"));
    if (!found.ok) return c.json({ error: found.error.message }, found.error.status);

    const path = parseProjectPath(new URL(c.req.url).searchParams.get("path"));
    if (!path.ok) return c.json({ error: path.error.message }, 400);

    const session = found.value;
    if (session.sandboxId === null) return c.json({ error: "this session has no sandbox" }, 404);

    const read = await deps.sandbox.readFile(session.sandboxId, path.value.absolute);
    if (!read.ok) return c.json({ error: read.error.message }, statusFor(read.error));

    return c.json({ path: path.value.relative, ...clamp(read.value) } satisfies FileContent);
  });
}

/**
 * Cut on a line boundary: half a line of source reads as a syntax error nobody wrote.
 *
 * `bytes` is the file's real UTF-8 size rather than its length in characters, because it is
 * shown to a person — a file of emoji reported as half its size on disk is a lie, and the two
 * numbers differ by a factor of four on some perfectly ordinary source files.
 */
function clamp(contents: string): Pick<FileContent, "contents" | "truncated" | "bytes"> {
  const bytes = Buffer.byteLength(contents, "utf8");

  if (bytes <= MAX_FILE_BYTES) return { contents, truncated: false, bytes };

  const head = contents.slice(0, MAX_FILE_BYTES);
  const lastBreak = head.lastIndexOf("\n");

  return {
    // A file with no newline inside the limit — minified output, one long line — has no
    // boundary to cut on, so it is cut where the limit falls.
    contents: lastBreak === -1 ? head : head.slice(0, lastBreak + 1),
    truncated: true,
    bytes,
  };
}
