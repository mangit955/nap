"use client";
import type { SessionSummary } from "@nap/shared/session-navigation";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { authClient } from "../auth/client.ts";
import { useSessionNavigation } from "../projects/use-session-navigation.ts";
import { SettingsShell } from "./settings-shell.tsx";

export function LiveArchivedSessions() {
  const { data, isPending } = authClient.useSession();
  const router = useRouter();
  useEffect(() => {
    if (!isPending && !data) router.replace("/sign-in");
  }, [data, isPending, router]);
  if (!data) return <main role="status">Loading archived sessions…</main>;
  return <ArchivedNavigation />;
}
function ArchivedNavigation() {
  const navigation = useSessionNavigation();
  return (
    <SettingsShell
      crumbs={[{ label: "Settings" }, { label: "Archived sessions" }]}
      activePage="archived"
    >
      <a href="/dashboard" className="text-sm text-muted hover:text-ink">
        Back to workspace
      </a>
      <h1 className="my-5 text-xl font-medium">Archived sessions</h1>
      {navigation.status === "loading" ? (
        <p role="status">Loading archived sessions…</p>
      ) : (
        <ArchivedSessions
          sessions={navigation.projects}
          busyProjectId={navigation.busyProjectId}
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
  busyProjectId,
  onRestore,
}: {
  sessions: readonly SessionSummary[];
  busyProjectId?: string | undefined;
  onRestore: (id: string) => void;
}) {
  const archived = sessions.filter((row) => row.navigation.archivedAt !== null);
  if (!archived.length) return <p className="text-sm text-muted">No archived sessions.</p>;
  return (
    <ul aria-label="Archived sessions" className="max-w-2xl divide-y divide-edge">
      {archived.map((row) => (
        <li key={row.projectId} className="flex items-center justify-between gap-4 py-3">
          <a href={`/p/${row.projectId}`} className="min-w-0 truncate text-sm hover:underline">
            {row.name}
          </a>
          <button
            type="button"
            disabled={!!busyProjectId}
            onClick={() => onRestore(row.projectId)}
            aria-label={`Restore ${row.name}`}
            className="rounded-md border border-edge px-3 py-1.5 text-xs hover:bg-hover disabled:opacity-40"
          >
            Restore
          </button>
        </li>
      ))}
    </ul>
  );
}
