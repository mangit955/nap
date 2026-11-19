/**
 * The project records this tab already holds, for drawing a project before its own record is in.
 *
 * Opening a project asks for `GET /projects/:id`, and until it answers the workspace knew neither
 * the name for its title nor the session its live connection subscribes to — so the title, the
 * stream ticket, the socket and every per-session read waited a whole round trip behind it. Yet
 * the tab usually had the record already: the sidebar's session list carries every field of one
 * (`SessionSummarySchema` extends `ProjectSummarySchema`), and a project the browser has just
 * created was answered by `POST /projects`.
 *
 * **A hint, never the truth.** `useProject` uses it only while the server's own record is on its
 * way: for the name, for the session to connect to, and to let reads addressed by project (the
 * GitHub state) go out at once. Whether the project is running, put away or gone is decided by the
 * record, so a list read ten seconds ago can never show a Resume button for a sandbox that is up. A session it named that turns out not to be the newest
 * is replaced when the record arrives, the way any change of session is.
 *
 * In memory, in this tab: a reload starts empty, and sign-out empties it
 * (`auth/forget-signed-out.ts`). A list that was asked for before a sign-out and answered after it
 * is not put in — see `knownProjectsEpoch`.
 */

import type { ProjectSummaryPayload } from "@nap/shared/projects-protocol";

/** Bounded, oldest first out: a session list is pages long for somebody with many projects. */
const MAX_KNOWN = 200;

const known = new Map<string, ProjectSummaryPayload>();
let epoch = 0;

/**
 * Which sign-in this tab is on, as a number that moves on every sign-out. A reader of the session
 * list takes it before asking and hands it back with the answer, so an answer that crossed a
 * sign-out is dropped instead of describing the last person's projects to the next.
 */
export function knownProjectsEpoch(): number {
  return epoch;
}

/**
 * Puts project records the client already holds in place of whatever was held for them: the
 * sidebar's `/sessions` rows, or the record of a project this tab has just created. Only the
 * fields of a project record are kept, so a session row's extra fields never leak into one.
 *
 * `since` is the epoch the records were asked for at; omitted, they are taken as current.
 */
export function rememberProjects(
  records: readonly ProjectSummaryPayload[],
  since: number = epoch,
): void {
  if (since !== epoch) return;
  for (const { projectId, name, status, sandboxId, updatedAt, sessionIds } of records) {
    known.delete(projectId);
    known.set(projectId, { projectId, name, status, sandboxId, updatedAt, sessionIds });
  }
  for (const oldest of known.keys()) {
    if (known.size <= MAX_KNOWN) break;
    known.delete(oldest);
  }
}

/** The record this tab holds for a project, if any. */
export function knownProject(projectId: string): ProjectSummaryPayload | undefined {
  return known.get(projectId);
}

/** Drops one project — it was deleted, and must not be drawn as if it were still there. */
export function forgetKnownProject(projectId: string): void {
  known.delete(projectId);
}

/** Drops every record — on sign-out, so the next person in this tab sees none of them. */
export function forgetKnownProjects(): void {
  epoch += 1;
  known.clear();
}
