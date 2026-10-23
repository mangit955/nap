import { NavigationSchema, type SessionSummary } from "@nap/shared/session-navigation";
import { render, screen, waitFor } from "@testing-library/react";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, expect, it, vi } from "vitest";
import { type ComposerDraft, ComposerDraftStore } from "../projects/composer-draft.ts";
import { DraftRows } from "./draft-rows.tsx";

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});
it("loads new-session drafts from IndexedDB, excludes existing sessions and expired drafts, and links back to the composer", async () => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  const ownerId = crypto.randomUUID();
  const make = (text: string): ComposerDraft => ({
    id: crypto.randomUUID(),
    ownerId,
    operationId: crypto.randomUUID(),
    text,
    source: null,
    attachments: [],
    expiresAt: Date.now() + 60000,
  });
  const draft = make("Build a calendar");
  const existing = make("Follow up");
  const expired = { ...make("Expired"), expiresAt: 0 };
  const store = new ComposerDraftStore();
  await Promise.all([draft, existing, expired].map((row) => store.save(row)));
  const session: SessionSummary = {
    projectId: existing.id,
    name: "Existing",
    status: "ready",
    sandboxId: null,
    sessionIds: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    navigation: NavigationSchema.parse({}),
    revision: 0,
    activity: "ready",
    activityAt: null,
    requestedAt: null,
    repository: null,
    branch: null,
    pullRequest: null,
    pendingFeedback: 0,
  };
  const view = render(
    <DraftRows
      ownerId={ownerId}
      draftIds={new Set([draft.id, existing.id, expired.id])}
      sessions={[session]}
      query=""
      repository=""
    />,
  );
  expect(await screen.findByRole("link", { name: /Build a calendar/ })).toHaveAttribute(
    "href",
    `/dashboard?draft=${draft.id}`,
  );
  expect(screen.queryByRole("link", { name: /Follow up|Expired/ })).toBeNull();
  view.rerender(
    <DraftRows
      ownerId={ownerId}
      draftIds={new Set()}
      sessions={[session]}
      query=""
      repository=""
    />,
  );
  await waitFor(() => expect(screen.queryByRole("list", { name: "Draft sessions" })).toBeNull());
});
