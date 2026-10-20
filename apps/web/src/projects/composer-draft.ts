import { GitHubRepositorySchema, RepositoryImportSchema } from "@nap/shared/github-protocol";
import { MediaAttachmentsSchema } from "@nap/shared/media";
import { SessionStartSchema } from "@nap/shared/session-start-protocol";
import { z } from "zod";

export const ComposerDraftSchema = z.object({
  id: z.uuid(),
  ownerId: z.uuid(),
  operationId: z.uuid(),
  pendingStart: SessionStartSchema.optional(),
  text: z.string(),
  model: z.string().optional(),
  source: RepositoryImportSchema.extend({ repository: GitHubRepositorySchema }).nullable(),
  attachments: MediaAttachmentsSchema,
  expiresAt: z.number(),
});
export type ComposerDraft = z.infer<typeof ComposerDraftSchema>;
const suspendedOwners = new Set<string>();

/** Prepared media lives in IndexedDB, never in a redirect URL or a small localStorage quota. */
export class ComposerDraftStore {
  constructor(private readonly factory: IDBFactory | undefined = globalThis.indexedDB) {}

  private open(): Promise<IDBDatabase> {
    if (!this.factory)
      return Promise.reject(
        new Error("Draft storage is unavailable. Keep this page open and try again."),
      );
    return new Promise((resolve, reject) => {
      const request = this.factory?.open("nap-composer-drafts", 1);
      if (!request) return reject(new Error("Draft storage is unavailable."));
      request.onupgradeneeded = () => {
        request.result.createObjectStore("drafts", { keyPath: ["ownerId", "id"] });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () =>
        reject(new Error("Could not open draft storage. Keep this page open and try again."));
      request.onblocked = () =>
        reject(new Error("Draft storage is busy. Close older Nap tabs and try again."));
    });
  }

  private async transact<T>(
    mode: IDBTransactionMode,
    run: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> {
    const db = await this.open();
    try {
      return await new Promise<T>((resolve, reject) => {
        const transaction = db.transaction("drafts", mode);
        const request = run(transaction.objectStore("drafts"));
        transaction.oncomplete = () => resolve(request.result);
        transaction.onabort = transaction.onerror = () =>
          reject(
            new Error(
              "Could not save the draft. Free browser storage and try again before leaving.",
            ),
          );
      });
    } finally {
      db.close();
    }
  }

  async save(draft: ComposerDraft): Promise<void> {
    if (suspendedOwners.has(draft.ownerId)) return;
    await this.transact("readwrite", (store) => store.put(ComposerDraftSchema.parse(draft)));
    try {
      const key = `nap.draft.${draft.ownerId}.${draft.id}`;
      if (draft.text.trim() || draft.attachments.length) localStorage.setItem(key, "1");
      else localStorage.removeItem(key);
      window.dispatchEvent(new Event("nap-drafts-changed"));
    } catch {
      /* Markers are optional; the draft itself is in IndexedDB. */
    }
  }

  async load(ownerId: string, id: string): Promise<ComposerDraft | null> {
    suspendedOwners.delete(ownerId);
    const raw: unknown = await this.transact("readonly", (store) => store.get([ownerId, id]));
    const parsed = ComposerDraftSchema.safeParse(raw);
    if (!parsed.success) return null;
    if (parsed.data.expiresAt <= Date.now()) {
      await this.remove(ownerId, id);
      return null;
    }
    return parsed.data;
  }

  async remove(ownerId: string, id: string): Promise<void> {
    await this.transact("readwrite", (store) => store.delete([ownerId, id]));
    try {
      localStorage.removeItem(`nap.draft.${ownerId}.${id}`);
      window.dispatchEvent(new Event("nap-drafts-changed"));
    } catch {
      /* Optional marker. */
    }
  }

  async clearOwner(ownerId: string): Promise<void> {
    suspendedOwners.add(ownerId);
    const rows: unknown[] = await this.transact("readonly", (store) => store.getAll());
    for (const row of rows) {
      const parsed = ComposerDraftSchema.safeParse(row);
      if (
        parsed.success &&
        (parsed.data.ownerId === ownerId || parsed.data.expiresAt <= Date.now())
      )
        await this.remove(parsed.data.ownerId, parsed.data.id);
    }
  }
}
