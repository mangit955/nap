import { IDBFactory } from "fake-indexeddb";
import { expect, it, vi } from "vitest";
import { type ComposerDraft, ComposerDraftStore } from "./composer-draft.ts";

function draft(ownerId = crypto.randomUUID()): ComposerDraft {
  return {
    id: crypto.randomUUID(),
    ownerId,
    operationId: crypto.randomUUID(),
    text: "Unsent work",
    source: null,
    attachments: [],
    expiresAt: Date.now() + 60000,
  };
}

it("background loads do not resume writes for a cleared owner", async () => {
  const factory = new IDBFactory();
  const store = new ComposerDraftStore(factory);
  const saved = draft();
  await store.save(saved);
  await store.clearOwner(saved.ownerId);
  expect(await new ComposerDraftStore(factory).load(saved.ownerId, saved.id)).toBeNull();
  await store.save(saved);
  expect(await store.load(saved.ownerId, saved.id)).toBeNull();
});

it("background reads of expired drafts do not mutate storage", async () => {
  const store = new ComposerDraftStore(new IDBFactory());
  const expired = { ...draft(), expiresAt: Date.now() - 1 };
  await store.save(expired);
  const remove = vi.spyOn(store, "remove");
  try {
    expect(await store.load(expired.ownerId, expired.id)).toBeNull();
    expect(remove).not.toHaveBeenCalled();
  } finally {
    remove.mockRestore();
  }
});

it("an authenticated composer can explicitly resume its owner, including without a saved draft", async () => {
  const factory = new IDBFactory();
  const store = new ComposerDraftStore(factory);
  const saved = draft();
  const other = draft();
  await store.save(saved);
  await store.save(other);
  await store.clearOwner(saved.ownerId);
  await store.clearOwner(other.ownerId);
  new ComposerDraftStore(factory).resumeOwner(saved.ownerId);
  await store.save(saved);
  await store.save(other);
  expect(await store.load(saved.ownerId, saved.id)).toEqual(saved);
  expect(await store.load(other.ownerId, other.id)).toBeNull();
});

it("a later sign-out suspends an explicitly resumed owner again", async () => {
  const store = new ComposerDraftStore(new IDBFactory());
  const saved = draft();
  await store.clearOwner(saved.ownerId);
  store.resumeOwner(saved.ownerId);
  await store.save(saved);
  expect(await store.load(saved.ownerId, saved.id)).toEqual(saved);
  await store.clearOwner(saved.ownerId);
  await store.save(saved);
  expect(await store.load(saved.ownerId, saved.id)).toBeNull();
});
