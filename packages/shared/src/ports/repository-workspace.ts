import type { JobOutcome } from "../events.ts";
import type { Result } from "../result.ts";
import type { SessionRecord } from "./session-store.ts";

export type RepositoryError = {
  code: "unavailable" | "access_denied" | "cancelled" | "conflict";
  message: string;
};

export type RepositorySource = {
  setupCommand: string | null;
  devCommand: string | null;
  previewPort: number | null;
  /** Called only when the project has never saved a snapshot. */
  initialBundle(): Promise<Result<Uint8Array, RepositoryError>>;
};

export type RepositoryJobOptions = {
  session: SessionRecord;
  sandboxId: string;
  jobId: string;
  requestId?: string;
  signal?: AbortSignal | undefined;
};

/** Repository credentials belong to this backend service, never to the sandbox or the model. */
export interface RepositoryWorkspace {
  /** Rechecks current access even when an existing sandbox can be resumed. */
  source(
    session: SessionRecord,
    signal?: AbortSignal,
  ): Promise<Result<RepositorySource | null, RepositoryError>>;
  prepareJob(options: RepositoryJobOptions): Promise<Result<void, RepositoryError>>;
  finishJob(
    options: RepositoryJobOptions & { outcome: JobOutcome },
  ): Promise<Result<void, RepositoryError>>;
}
