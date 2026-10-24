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

import { type ExecutionSelection, ExecutionSelectionSchema } from "@nap/shared/execution-target";
import type { SessionExecutionStore } from "@nap/shared/ports/session-execution-store";
import type { SessionRecord, SessionStore } from "@nap/shared/ports/session-store";
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
  executionSelection?: ExecutionSelection;
};

export class InMemorySessionStore implements SessionStore, SessionExecutionStore {
  readonly #sessions = new Map<string, SessionRecord>();

  constructor(seed: SeedSession[] = []) {
    for (const session of seed) {
      this.#sessions.set(session.sessionId, {
        sessionId: session.sessionId,
        projectId: session.projectId,
        userId: session.userId ?? FAKE_OWNER,
        sandboxId: session.sandboxId ?? null,
        ...(session.executionSelection === undefined
          ? {}
          : { executionSelection: ExecutionSelectionSchema.parse(session.executionSelection) }),
      });
    }
  }

  async get(sessionId: string): Promise<SessionRecord | null> {
    const record = this.#sessions.get(sessionId);
    return record === undefined ? null : structuredClone(record);
  }

  async selection(
    userId: string,
    sessionId: string,
  ): Promise<{ selection: ExecutionSelection | null } | null> {
    const record = await this.get(sessionId);
    return record?.userId === userId ? { selection: record.executionSelection ?? null } : null;
  }

  async select(userId: string, sessionId: string, selection: ExecutionSelection): Promise<boolean> {
    const record = this.#sessions.get(sessionId);
    if (record?.userId !== userId) return false;
    this.#sessions.set(sessionId, {
      ...record,
      executionSelection: ExecutionSelectionSchema.parse(selection),
    });
    return true;
  }

  async setSandboxId(sessionId: string, sandboxId: string): Promise<void> {
    const record = this.#sessions.get(sessionId);
    if (record === undefined) throw new Error(`unknown session ${sessionId}`);

    this.#sessions.set(sessionId, { ...record, sandboxId });
  }
}
