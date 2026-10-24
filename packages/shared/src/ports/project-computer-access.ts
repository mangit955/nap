import type { Result } from "../result.ts";

/**
 * Owner input and lease grants share a project guard across processes. Queued requests alone
 * allow input; any leased request in any project session denies it, including expired leases
 * awaiting the janitor. Missing projects and another owner's projects both return not_found.
 */
export interface ProjectComputerAccess {
  /**
   * Hold the owned project row lock until the callback settles. The sandbox and revision come
   * from that locked row. Every successful claim changes the revision, even if its turn finishes
   * before the next input, so callers must compare prior grants inside this callback.
   *
   * Await bounded physical actions here. Detached work is outside the guard; calling back into
   * stores that lock this project can deadlock. Callback failures propagate after rollback and
   * release. The guard is never held for an entire turn or takeover connection.
   */
  withIdleProject<T>(
    request: { projectId: string; userId: string },
    operation: (computer: { sandboxId: string | null; revision: string }) => Promise<T>,
  ): Promise<Result<T, { code: "busy" | "not_found" }>>;
}
