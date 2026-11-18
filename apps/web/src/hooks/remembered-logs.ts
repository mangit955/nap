/**
 * What this tab last saw of each project's event log, kept between visits.
 *
 * Leaving a project throws its workspace away on purpose (see `workspace/live-workspace.tsx`), and
 * coming back used to replay the whole log from `seq=0`: a few hundred events and a couple of
 * seconds of "Loading this conversation" for something on screen a minute earlier. Keeping the log
 * here lets a revisit draw the transcript at once and ask the server only for what came after it.
 *
 * **In memory, in this tab, and nowhere else.** Nothing is written to storage: a log holds
 * everything a person and the agent said, and a cache that outlived the tab would outlive a
 * sign-out on a shared machine. A reload starts empty, which costs one full replay.
 *
 * **Keyed by project, holding the session it belongs to.** The project is what the URL names, and
 * it is known at the click; the session is only known once the project's record has come back. So
 * the transcript can be drawn before the record answers, and the stream still resumes only when
 * the record names the same session the log was kept for.
 *
 * Bounded by count, least recently used first out, since a person switching between projects all
 * day otherwise keeps every log they ever opened.
 */

import type { StoredEvent } from "@nap/shared/ports/event-store";

/** How many projects' logs a tab keeps. A sidebar's worth of recent work. */
export const REMEMBERED_PROJECTS = 12;

export type RememberedLog = {
  sessionId: string;
  /** In `seq` order, contiguous from the start of the log — a prefix the server can resume after. */
  events: readonly StoredEvent[];
};

const logs = new Map<string, RememberedLog>();

/** The log last seen for this project, if this tab has one. Counts as a use for the bound. */
export function recallLog(projectId: string): RememberedLog | undefined {
  const log = logs.get(projectId);
  if (log === undefined) return undefined;
  logs.delete(projectId);
  logs.set(projectId, log);
  return log;
}

/**
 * Keeps a project's log, replacing whatever was kept for it.
 *
 * An empty log is not kept: there is nothing to draw from it, and drawing a project as empty
 * before the server has said so would invite a first message into a conversation that may have
 * had turns since.
 */
export function rememberLog(projectId: string, sessionId: string, events: readonly StoredEvent[]) {
  logs.delete(projectId);
  if (events.length === 0) return;
  logs.set(projectId, { sessionId, events });
  for (const oldest of logs.keys()) {
    if (logs.size <= REMEMBERED_PROJECTS) break;
    logs.delete(oldest);
  }
}

/** Drops one project's log — it was deleted, and its transcript must not be drawn again. */
export function forgetLog(projectId: string): void {
  logs.delete(projectId);
}

/** Drops every log — on sign-out, so the next person in this tab sees none of them. */
export function forgetAllLogs(): void {
  logs.clear();
}
