/**
 * A person's projects, as they appear when they are choosing one.
 *
 * Everything else that reads a project reads it for a turn — which sandbox is serving it, when
 * it was last busy. This is the other direction: what somebody sees when they arrive and have
 * to pick a thing to work on, and what happens when they decide they are done with one.
 *
 * Deliberately separate from `ProjectSandboxStore`, which is the reaper's slice, and from
 * `SessionStore`, which is a turn's. Three narrow interfaces over the same two tables, each
 * one implementable by a fake in a few lines, is the reason any of their callers can be tested
 * without a database.
 *
 * `delete` is here rather than in a wider "write" interface because it is the one destructive
 * operation in the system, and it belongs next to the listing that shows what is about to be
 * destroyed. Deleting the *bytes* is not this: rows and objects fail independently, and the
 * caller that coordinates them has to see both.
 */

export type ProjectStatus =
  /** The row exists and no sandbox has ever been made for it. */
  | "creating"
  /** A sandbox is serving it right now. */
  | "ready"
  /** Put away: no sandbox, restorable from the snapshot the row points at. */
  | "idle"
  /** Reserved. Nothing sets these yet; they are in the database enum. */
  | "archived"
  | "error";

export type ProjectSummary = {
  projectId: string;
  name: string;
  status: ProjectStatus;
  /** Null when nothing is running for it, which is the ordinary state of an old project. */
  sandboxId: string | null;
  updatedAt: string;
  /**
   * Every conversation in the project, **newest first** — so `[0]` is where opening it goes.
   *
   * The whole list rather than just that one, because a sandbox belongs to the project its
   * sessions share: anything asking "is this project busy?" has to ask about all of them.
   * Empty is possible in principle and means a project nobody has talked in yet; nothing
   * creates one that way, but a client cannot assume it and then crash on the row that proves
   * otherwise.
   */
  sessionIds: string[];
};

/**
 * Every method takes the user whose projects these are, and none of them is optional.
 *
 * The scoping lives in the query rather than in the handler above it, which is the whole point:
 * a filter a caller has to remember to apply is a filter that will eventually not be applied,
 * and the failure is silent — a listing that quietly includes somebody else's work. Passing the
 * id in means the type system asks the question at every call site.
 *
 * A project belonging to someone else is reported the same way as one that does not exist:
 * `null`, or `false`. Distinguishing them would confirm the row is there, which is a fact about
 * another person's data that nobody outside it should be able to establish.
 */
export interface ProjectStore {
  /** This user's projects, most recently active first. */
  list(userId: string): Promise<ProjectSummary[]>;

  get(projectId: string, userId: string): Promise<ProjectSummary | null>;

  /**
   * Removes the project and everything the database hangs off it — sessions, events, snapshot
   * rows. **Not the objects those rows point at**, which live somewhere else entirely and have
   * to be deleted first, or nothing is left that knows their keys.
   *
   * False means there was no such project *for this user*. Not an error: two clicks on the same
   * button, or two tabs, and the second is a caller finding out the row is already gone — which
   * is what it wanted.
   */
  delete(projectId: string, userId: string): Promise<boolean>;
}
