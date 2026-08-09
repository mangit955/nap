/**
 * Where a session's project and its live sandbox are looked up.
 *
 * A turn request carries a session id and a message, and nothing else — so something has to
 * answer "which project is this, and is there already a sandbox serving it?". That answer
 * outlives a turn: the sandbox created for the first message is the one the second message
 * must resume, or the project reverts to an empty template.
 *
 * Deliberately two methods. The full lifecycle of a project — creating, listing, renaming,
 * archiving — belongs to project CRUD; this is only the slice turn orchestration needs, and
 * a wider interface here would mean every caller with a fake had to implement all of it.
 */

export type SessionRecord = {
  sessionId: string;
  projectId: string;
  /** Null until a sandbox has been created for this project. */
  sandboxId: string | null;
};

export interface SessionStore {
  /** Null when no such session exists, which is a caller error rather than a turn failure. */
  get(sessionId: string): Promise<SessionRecord | null>;

  /** Records the sandbox now serving this session's project, so the next turn resumes it. */
  setSandboxId(sessionId: string, sandboxId: string): Promise<void>;
}
