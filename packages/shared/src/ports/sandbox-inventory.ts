/**
 * What the provider thinks exists, which is the only source for a sandbox nothing references.
 *
 * `SandboxManager` answers questions about *a* sandbox — every method takes an id — and that is
 * exactly what cannot be asked when the id has been lost. A sandbox created just before the
 * transaction recording it failed is running, is billed, and is named nowhere in the database;
 * the only way to find it is to ask the provider what it is running.
 *
 * Separate from `SandboxManager` for the reason `ping` is: this is a question about the
 * deployment rather than about anybody's project, and putting it on that port would oblige
 * every implementation to answer something meaningless. Whoever needs it holds it explicitly.
 */

import type { Result } from "../result.ts";
import type { SandboxError } from "./sandbox-manager.ts";

export type SandboxListing = {
  id: string;
  /**
   * The project the sandbox was created for, as the provider recorded it, or null when there
   * is no such record.
   *
   * Load-bearing for anything that destroys: null means nothing in this system created it, so
   * an account shared with something else does not lose that other thing's sandboxes to our
   * sweep.
   */
  projectId: string | null;
  /**
   * When the sandbox started, as an ISO string.
   *
   * Also load-bearing for a sweep: a sandbox seconds old and referenced by nothing is far more
   * likely to be one being created right now than one that leaked.
   */
  startedAt: string;
};

export interface SandboxInventory {
  /**
   * Every sandbox the provider is currently running for this account.
   *
   * A `Result` rather than a throw, like the rest of this boundary: a provider that cannot be
   * reached is an ordinary outcome for a sweep, which simply tries again next tick.
   */
  list(): Promise<Result<SandboxListing[], SandboxError>>;
}
