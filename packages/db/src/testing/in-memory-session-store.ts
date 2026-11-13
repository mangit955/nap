/**
 * A `SessionStore` holding sessions in a map.
 *
 * Seeded with the sessions a test wants to exist, so "this session has no sandbox yet",
 * "this session has one" and "this session does not exist" are all one line to set up —
 * the three branches turn acquisition has to get right.
 *
 * Recording a sandbox for a session that does not exist **throws**. The real store would be
 * updating a row that isn't there, and a caller reaching this line has already looked the
 * session up: it is a bug in the caller rather than an outcome to hand back.
 */

import type { ProjectStore } from "@nap/shared/ports/project-store";
import type { SessionRecord, SessionStore } from "@nap/shared/ports/session-store";
import { UNTITLED_PROJECT } from "@nap/shared/project-title";
import { FAKE_OWNER } from "./in-memory-project-store.ts";

/** A session to start with. `sandboxId` defaults to none, `userId` to the shared fake owner. */
export type SeedSession = {
  sessionId: string;
  projectId: string;
  /**
   * Whose project this session belongs to. Defaulted, because most tests here are about turn
   * acquisition rather than about who is asking — but a real value, and the same one the
   * project fake defaults to, so a test that *is* about ownership can name a second user and
   * get a genuine mismatch rather than two undefineds comparing equal.
   */
  userId?: string;
  sandboxId?: string | null;
  /**
   * The project's name when no project store is linked. Defaults to the name a new project is
   * given, since that is what a session nobody named belongs to.
   */
  projectName?: string;
};

export type InMemorySessionStoreOptions = {
  /**
   * Where the project's name is read from, as the real store reads it from the row it joins.
   * Linked, a rename through the project store is what the next `get` reports; unlinked, the
   * seeded name stands, and a test that renames a project would be reading a stale copy.
   */
  projects?: Pick<ProjectStore, "get">;
};

export class InMemorySessionStore implements SessionStore {
  readonly #sessions = new Map<string, SessionRecord>();
  readonly #projects: Pick<ProjectStore, "get"> | undefined;

  constructor(seed: SeedSession[] = [], options: InMemorySessionStoreOptions = {}) {
    this.#projects = options.projects;
    for (const session of seed) {
      this.#sessions.set(session.sessionId, {
        sessionId: session.sessionId,
        projectId: session.projectId,
        userId: session.userId ?? FAKE_OWNER,
        sandboxId: session.sandboxId ?? null,
        projectName: session.projectName ?? UNTITLED_PROJECT,
      });
    }
  }

  async get(sessionId: string): Promise<SessionRecord | null> {
    const record = this.#sessions.get(sessionId);
    if (record === undefined) return null;

    const project = await this.#projects?.get(record.projectId, record.userId);
    return { ...record, ...(project == null ? {} : { projectName: project.name }) };
  }

  async setSandboxId(sessionId: string, sandboxId: string): Promise<void> {
    const record = this.#sessions.get(sessionId);
    if (record === undefined) throw new Error(`unknown session ${sessionId}`);

    this.#sessions.set(sessionId, { ...record, sandboxId });
  }
}
