"use client";
import { type SessionSummary, sessionSection } from "@nap/shared/session-navigation";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { authClient } from "../auth/client.ts";
import { useSessionNavigation } from "../projects/use-session-navigation.ts";
import { SettingsShell } from "./settings-shell.tsx";
import { FOCUS } from "./settings-ui.tsx";

export function LiveArchivedSessions({ draftId }: { draftId?: string | undefined }) {
  const { data, isPending } = authClient.useSession();
  const router = useRouter();
  useEffect(() => {
    if (!isPending && !data) router.replace("/sign-in");
  }, [data, isPending, router]);
  if (!data) return <main role="status">Loading archived sessions…</main>;
  return <ArchivedNavigation draftId={draftId} />;
}
function ArchivedNavigation({ draftId }: { draftId: string | undefined }) {
  const navigation = useSessionNavigation();
  return (
    <SettingsShell
      crumbs={[{ label: "Settings" }, { label: "Archived sessions" }]}
      activePage="archived"
      draftId={draftId}
    >
      <h1 className="mb-5 text-xl font-medium tracking-tight text-ink">Archived sessions</h1>
      {navigation.status === "loading" ? (
        <p role="status">Loading archived sessions…</p>
      ) : (
        <ArchivedSessions
          sessions={navigation.projects}
          onRestore={(id) => void navigation.change(id, { kind: "archive", value: false })}
        />
      )}
      {(navigation.actionError || navigation.status === "error") && (
        <p role="alert" className="mt-4 text-sm text-danger">
          {navigation.actionError ?? "Could not load sessions."}
        </p>
      )}
    </SettingsShell>
  );
}
export function ArchivedSessions({
  sessions,
  onRestore,
}: {
  sessions: readonly SessionSummary[];
  onRestore: (id: string) => void;
}) {
  const now = Date.now();
  const archived = sessions.filter((row) => sessionSection(row, now) === "archived");
  if (!archived.length) return <p className="text-sm text-muted">No archived sessions.</p>;
  return (
    <ul
      aria-label="Archived sessions"
      className="divide-y divide-edge/25 rounded-lg border border-edge/30"
    >
      {archived.map((row) => (
        <li key={row.projectId} className="flex items-center justify-between gap-3 px-3 py-2">
          <a
            href={`/p/${row.projectId}`}
            className={`min-w-0 truncate rounded text-sm hover:underline ${FOCUS}`}
          >
            {row.name}
          </a>
          <button
            type="button"
            onClick={() => onRestore(row.projectId)}
            aria-label={`Restore ${row.name}`}
            className={`h-7 shrink-0 rounded-md border border-edge/55 px-2 text-xs text-ink-2 hover:bg-hover hover:text-ink ${FOCUS}`}
          >
            Restore
          </button>
        </li>
      ))}
    </ul>
  );
}
