/**
 * The fake sandbox, made findable from a process that did not create it.
 *
 * The in-memory fake lives inside whichever process created it, which is fine for one process and
 * wrong for a cluster: a worker pod that claims a turn for a project another pod has already run
 * misses on `resume`, and the runtime opens a brand new sandbox — paying the calibrated cold
 * start, `CALIBRATION.sandboxCreateMs`. With four workers sharing a hundred projects that is most
 * turns, which is what put `queue_wait` and `time_to_first_event` over their §23 thresholds on the
 * first cluster run: the harness measuring itself. A real E2B sandbox is a vendor-side resource
 * that `resume` reattaches to by id from any pod, and this is what makes the fake behave that way.
 *
 * It is a wrapper for the reason `slow-ports.ts` is one: the in-memory manager is held to the
 * `SandboxManager` contract by a conformance suite, and a second implementation whose only
 * difference is where it keeps its state would drift from it. Nothing that ships changes.
 *
 * **Identity is this module's job.** The id a caller sees is the one the creating process minted,
 * and it stays that id everywhere — because the session row records it and every later turn, on
 * whatever pod, resumes by it. A reattach underneath is a *local* sandbox with a local id, so
 * every call translates the shared id to it and the preview address is composed back the other
 * way; a URL that changed per pod would be a fake nobody could follow.
 *
 * **A reattach is not slowed, and that is deliberate.** No funded run ever timed one — the note on
 * `slowSandboxManager.resume` says the same thing — so the only honest cost is the work it really
 * does, which is a round trip to the store. Inventing a figure here would be inventing the very
 * number this exists to stop the run from paying.
 */

import type {
  ExecOutputHandler,
  ExecResult,
  FileNode,
  Sandbox,
  SandboxError,
  SandboxManager,
} from "@nap/shared/ports/sandbox-manager";
import type { Result, VoidResult } from "@nap/shared/result";

/**
 * One sandbox, as the processes that did not create it can see it.
 *
 * `files` is what was written *through* the manager, not the whole filesystem: every process
 * seeds its fake from the same template, so the template's files are already there and copying
 * them into the store would be shipping a constant through Postgres once per sandbox.
 */
export type SharedSandboxRecord = {
  sandboxId: string;
  projectId: string;
  files: Record<string, string>;
};

/**
 * Where the record lives. A port, because `packages/loadgen` knows nothing about a database —
 * the Postgres implementation belongs to the composition that already has one open.
 */
export type SharedSandboxStore = {
  /** Remembers a sandbox that has just been created. */
  record(record: SharedSandboxRecord): Promise<void>;
  /** The record for an id, or `null` when no process ever created it or one destroyed it. */
  find(sandboxId: string): Promise<SharedSandboxRecord | null>;
  /** Replaces a sandbox's files. A no-op for an id the store does not hold. */
  saveFiles(sandboxId: string, files: Record<string, string>): Promise<void>;
  /** Forgets a destroyed sandbox, so no process reattaches to one that is gone. */
  forget(sandboxId: string): Promise<void>;
};

type Attachment = {
  /** The id the wrapped manager knows this sandbox by, in this process. */
  localId: string;
  /** Everything written through this wrapper, mirrored so a write-through can send it all. */
  files: Map<string, string>;
};

export function sharedSandboxManager(
  inner: SandboxManager,
  store: SharedSandboxStore,
): SandboxManager {
  /** Shared id → what this process holds for it. */
  const attachments = new Map<string, Attachment>();

  /**
   * The local id for a shared one, or the shared one itself.
   *
   * The fallthrough matters: an id this process has never attached is one the wrapped manager
   * should be asked about directly, so that "no such sandbox" and "it was destroyed" come back
   * as the fake's own answers rather than as something invented here.
   */
  function local(sandboxId: string): string {
    return attachments.get(sandboxId)?.localId ?? sandboxId;
  }

  async function writeThrough(sandboxId: string, path: string, contents: string): Promise<void> {
    const attachment = attachments.get(sandboxId);
    if (attachment === undefined) return;
    attachment.files.set(path, contents);
    await store.saveFiles(sandboxId, Object.fromEntries(attachment.files));
  }

  /** Builds a local sandbox holding what the record says, and binds the shared id to it. */
  async function attach(record: SharedSandboxRecord): Promise<Result<Sandbox, SandboxError>> {
    const opened = await inner.create(record.projectId);
    if (!opened.ok) return opened;

    for (const [path, contents] of Object.entries(record.files)) {
      const written = await inner.writeFile(opened.value.id, path, contents);
      if (!written.ok) return written;
    }

    attachments.set(record.sandboxId, {
      localId: opened.value.id,
      files: new Map(Object.entries(record.files)),
    });

    return { ok: true, value: { id: record.sandboxId, projectId: record.projectId } };
  }

  const shared: SandboxManager = {
    create: async (projectId) => {
      const opened = await inner.create(projectId);
      if (!opened.ok) return opened;

      attachments.set(opened.value.id, { localId: opened.value.id, files: new Map() });
      await store.record({ sandboxId: opened.value.id, projectId, files: {} });
      return opened;
    },

    resume: async (sandboxId) => {
      const attached = attachments.get(sandboxId);
      if (attached !== undefined) {
        const resumed = await inner.resume(attached.localId);
        if (!resumed.ok) return resumed;
        return { ok: true, value: { id: sandboxId, projectId: resumed.value.projectId } };
      }

      const record = await store.find(sandboxId);
      // Not the store's word for it: a sandbox no process ever created and one that was
      // destroyed read differently, and the wrapped manager is the thing that knows which.
      if (record === null) return await inner.resume(sandboxId);

      return await attach(record);
    },

    destroy: async (sandboxId) => {
      const destroyed = await inner.destroy(local(sandboxId));
      if (!destroyed.ok) return destroyed;

      attachments.delete(sandboxId);
      // After the fake agreed it was destroyed, so a failed destroy leaves the record in place
      // rather than stranding a sandbox that is still running.
      await store.forget(sandboxId);
      return destroyed;
    },

    extendTimeout: (sandboxId, ms) => inner.extendTimeout(local(sandboxId), ms),

    writeFile: async (sandboxId, path, contents): Promise<VoidResult<SandboxError>> => {
      const written = await inner.writeFile(local(sandboxId), path, contents);
      if (!written.ok) return written;

      await writeThrough(sandboxId, path, contents);
      return written;
    },

    readFile: (sandboxId, path): Promise<Result<string, SandboxError>> =>
      inner.readFile(local(sandboxId), path),

    listFiles: (sandboxId, path): Promise<Result<FileNode[], SandboxError>> =>
      inner.listFiles(local(sandboxId), path),

    exec: (
      sandboxId,
      command,
      onOutput?: ExecOutputHandler,
    ): Promise<Result<ExecResult, SandboxError>> => inner.exec(local(sandboxId), command, onOutput),

    getPreviewUrl: async (sandboxId, port) => {
      const url = await inner.getPreviewUrl(local(sandboxId), port);
      if (!url.ok) return url;
      return { ok: true, value: url.value.replaceAll(local(sandboxId), sandboxId) };
    },

    waitForPreview: async (sandboxId, port, opts) => {
      const url = await inner.waitForPreview(local(sandboxId), port, opts);
      if (!url.ok) return url;
      return { ok: true, value: url.value.replaceAll(local(sandboxId), sandboxId) };
    },
  };

  return shared;
}
