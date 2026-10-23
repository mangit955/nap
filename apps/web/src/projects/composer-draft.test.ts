import { IDBFactory } from "fake-indexeddb";
import { expect, it } from "vitest";
import { ComposerDraftStore } from "./composer-draft.ts";

it("preserves prepared media, model and source across reload, isolates owners, expires and clears on sign-out", async () => {
  const factory = new IDBFactory();
  const store = new ComposerDraftStore(factory);
  const draft = {
    id: crypto.randomUUID(),
    ownerId: crypto.randomUUID(),
    operationId: crypto.randomUUID(),
    text: "Fix the header",
    model: "openai/gpt-5.6-luna",
    source: null,
    attachments: [
      {
        kind: "image" as const,
        name: "header.jpg",
        frames: [{ data: "aGVsbG8=", mediaType: "image/jpeg" as const, timestamp: 0 }],
      },
    ],
    expiresAt: Date.now() + 10000,
  };
  await store.save(draft);
  expect(await new ComposerDraftStore(factory).load(draft.ownerId, draft.id)).toEqual(draft);
  expect(await store.load(crypto.randomUUID(), draft.id)).toBeNull();
  await store.clearOwner(draft.ownerId);
  expect(await store.load(draft.ownerId, draft.id)).toBeNull();
  store.resumeOwner(draft.ownerId);
  await store.save({ ...draft, expiresAt: Date.now() - 1 });
  expect(await store.load(draft.ownerId, draft.id)).toBeNull();
  await store.save(draft);
  expect(await store.load(draft.ownerId, draft.id)).toEqual(draft);
  await store.remove(draft.ownerId, draft.id);
  expect(await store.load(draft.ownerId, draft.id)).toBeNull();
});

it("reports unavailable storage instead of pretending a draft is safe", async () => {
  await expect(new ComposerDraftStore(undefined).load("owner", "draft")).rejects.toThrow(
    /storage/i,
  );
});
