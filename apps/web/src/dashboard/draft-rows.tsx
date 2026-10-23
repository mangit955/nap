"use client";
import type { SessionSummary } from "@nap/shared/session-navigation";
import { SquarePen } from "lucide-react";
import { useEffect, useState } from "react";
import { type ComposerDraft, ComposerDraftStore } from "../projects/composer-draft.ts";
import { sessionSource } from "./session-rows.ts";

export function DraftRows({
  ownerId,
  draftIds,
  sessions,
  query,
  repository,
}: {
  ownerId?: string | undefined;
  draftIds: ReadonlySet<string>;
  sessions: readonly SessionSummary[];
  query: string;
  repository: string;
}) {
  const [drafts, setDrafts] = useState<ComposerDraft[]>([]);
  const sessionIds = sessions
    .map((row) => row.projectId)
    .sort()
    .join(",");
  useEffect(() => {
    let current = true;
    setDrafts([]);
    if (!ownerId) return;
    const existing = new Set(sessionIds.split(","));
    const store = new ComposerDraftStore();
    void Promise.all(
      [...draftIds].filter((id) => !existing.has(id)).map((id) => store.load(ownerId, id)),
    )
      .then((rows) => {
        if (current)
          setDrafts(
            rows.filter(
              (row): row is ComposerDraft =>
                row !== null && !!(row.text.trim() || row.attachments.length),
            ),
          );
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [ownerId, draftIds, sessionIds]);
  const visible = drafts.filter(
    (draft) =>
      (!repository ||
        sessionSource(draft.source?.repository.fullName ?? null).key === repository) &&
      draft.text.toLowerCase().includes(query.trim().toLowerCase()),
  );
  if (!visible.length) return null;
  return (
    <ul aria-label="Draft sessions" className="mb-2 shrink-0 border-b border-edge pb-2">
      {visible.map((draft) => (
        <li key={draft.id}>
          <a
            href={`/dashboard?draft=${draft.id}`}
            className="my-0.5 flex items-center gap-2 rounded-md bg-warning/[0.04] px-2.5 py-2 text-sm text-warning hover:bg-warning/[0.08]"
          >
            <SquarePen aria-hidden className="size-3.5 shrink-0" />
            <span className="truncate">{draft.text.trim() || "New session"}</span>
            <span className="ml-auto text-xs">Draft</span>
          </a>
        </li>
      ))}
    </ul>
  );
}
