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

import type { SessionRecord, SessionStore } from "@nap/shared/ports/session-store";

/** A session to start with. `sandboxId` defaults to none. */
export type SeedSession = {
  sessionId: string;
  projectId: string;
  sandboxId?: string | null;
};

export class InMemorySessionStore implements SessionStore {
  readonly #sessions = new Map<string, SessionRecord>();

  constructor(seed: SeedSession[] = []) {
    for (const session of seed) {
      this.#sessions.set(session.sessionId, {
        sessionId: session.sessionId,
        projectId: session.projectId,
        sandboxId: session.sandboxId ?? null,
      });
    }
  }

  async get(sessionId: string): Promise<SessionRecord | null> {
    const record = this.#sessions.get(sessionId);
    return record === undefined ? null : { ...record };
  }

  async setSandboxId(sessionId: string, sandboxId: string): Promise<void> {
    const record = this.#sessions.get(sessionId);
    if (record === undefined) throw new Error(`unknown session ${sessionId}`);

    this.#sessions.set(sessionId, { ...record, sandboxId });
  }
}
