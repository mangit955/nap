"use client";

import {
  GitHubConnectionsSchema,
  GitHubConnectResponseSchema,
  type GitHubInstallation,
} from "@nap/shared/github-protocol";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { z } from "zod";
import { credentialedFetch } from "../api/credentialed-fetch.ts";
import type { FetchJson } from "../files/use-project-files.ts";
import { SettingsShell } from "../settings/settings-shell.tsx";
import { BUTTON, Callout, FOCUS, PRIMARY_BUTTON } from "../settings/settings-ui.tsx";
import { ChevronRight, ExternalIcon, GithubIcon, PlusIcon } from "../ui/icons.tsx";
import { GITHUB_API_URL, githubRequest } from "./request.ts";

const disconnectSchema = z.object({ disconnected: z.literal(true) });
const navigateTo = (url: string) => window.location.assign(url);
const STATUS = {
  active: "Connected",
  suspended: "Suspended",
  removed: "Uninstalled",
  disconnected: "Disconnected",
};
/** States GitHub put the installation in. `disconnected` was the owner's own choice, so it is not trouble. */
export const TROUBLE = new Set<GitHubInstallation["status"]>(["suspended", "removed"]);
const RECONNECT = {
  suspended: "The App is suspended on GitHub. Reconnect once it has been unsuspended.",
  removed: "The App was uninstalled on GitHub. Reconnect to install it again.",
  disconnected: "nap no longer uses this connection. Reconnect to use it again.",
};
function installationUrl(item: GitHubInstallation): string {
  return item.accountType === "Organization"
    ? `https://github.com/organizations/${encodeURIComponent(item.accountLogin)}/settings/installations/${item.installationId}`
    : `https://github.com/settings/installations/${item.installationId}`;
}

type AccessUpdate =
  | { kind: "idle" }
  | { kind: "pending"; installationId: number | undefined }
  | { kind: "failed"; installationId: number | undefined; error: string };

export function GitHubConnections({
  fetchJson = credentialedFetch,
  baseUrl = GITHUB_API_URL,
  navigate = navigateTo,
  callbackStatus,
  draftId,
}: {
  fetchJson?: FetchJson;
  baseUrl?: string;
  navigate?: (url: string) => void;
  callbackStatus?: string | undefined;
  draftId?: string | undefined;
}) {
  const [connection, setConnection] = useState<z.infer<typeof GitHubConnectionsSchema>>();
  const [loadError, setLoadError] = useState<string>();
  const [update, setUpdate] = useState<AccessUpdate>({ kind: "idle" });
  const busy = update.kind === "pending";

  const reload = useCallback(async () => {
    const result = await githubRequest(
      fetchJson,
      `${baseUrl}/github/connections`,
      GitHubConnectionsSchema,
    );
    if (result.ok) {
      setConnection(result.value);
      setLoadError(undefined);
    } else setLoadError(result.error);
  }, [fetchJson, baseUrl]);

  useEffect(() => {
    void reload();
  }, [reload]);
  useEffect(() => {
    const refresh = () => {
      void reload();
    };
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [reload]);

  const connect = async (installationId?: number) => {
    setUpdate({ kind: "pending", installationId });
    const result = await githubRequest(
      fetchJson,
      `${baseUrl}/github/connect`,
      GitHubConnectResponseSchema,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ installationId, draftId }),
      },
    );
    if (result.ok) navigate(result.value.url);
    else setUpdate({ kind: "failed", installationId, error: result.error });
  };

  const disconnect = async (installationId: number, onDisconnected: () => void) => {
    setUpdate({ kind: "pending", installationId });
    const result = await githubRequest(
      fetchJson,
      `${baseUrl}/github/installations/${installationId}`,
      disconnectSchema,
      { method: "DELETE" },
    );
    if (result.ok) {
      onDisconnected();
      await reload();
      setUpdate({ kind: "idle" });
    } else setUpdate({ kind: "failed", installationId, error: result.error });
  };

  const draft = draftId ? `?draft=${draftId}` : "";
  const appHref = draftId ? `/dashboard?draft=${draftId}&repositories=1` : "/dashboard";

  return (
    <SettingsShell
      crumbs={[
        { label: "Settings" },
        { label: "Connections", href: `/settings/connections${draft}` },
        { label: "GitHub" },
      ]}
      draftId={draftId}
      nested
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="flex items-center gap-2 font-medium text-xl tracking-tight">
          <GithubIcon className="size-5" />
          GitHub
        </h1>
        {connection?.configured && (
          <button
            type="button"
            className={PRIMARY_BUTTON}
            disabled={busy}
            onClick={() => void connect()}
          >
            <PlusIcon className="size-3.5" />
            Add connection
          </button>
        )}
      </div>

      {update.kind !== "idle" && update.installationId === undefined && (
        <div className="mt-3">
          <AccessFeedback update={update} />
        </div>
      )}

      {callbackStatus &&
        (callbackStatus === "connected" ? (
          <Callout
            role="status"
            title="GitHub connected"
            action={
              <a href={appHref} className={PRIMARY_BUTTON}>
                {draftId ? "Back to draft" : "Open dashboard"}
              </a>
            }
          >
            Choose one of its repositories in the new-session composer to start working on it.
          </Callout>
        ) : (
          <Callout role="alert" tone="danger" title="GitHub was not connected">
            The GitHub connection could not be completed. Add the connection again to retry.
          </Callout>
        ))}

      <div className="mt-5 divide-y divide-edge/25 rounded-lg border border-edge/30">
        {!connection && !loadError && (
          <p role="status" className="px-5 py-4 text-[13px] text-muted">
            Loading connections…
          </p>
        )}
        {connection?.configured === false && (
          <p className="px-5 py-4 text-[13px] leading-relaxed text-ink-2">
            GitHub is not configured for this nap deployment yet. The deployment administrator needs
            to register the GitHub App and configure its credentials.
          </p>
        )}
        {connection?.configured && connection.installations.length === 0 && (
          <div className="px-5 py-4">
            <p className="text-sm text-ink">No GitHub connections yet.</p>
            <p className="mt-0.5 text-[13px] text-muted">
              Add a connection to choose which repositories nap can reach.
            </p>
          </div>
        )}
        {loadError && !connection && (
          <p className="px-5 py-4 text-[13px] text-muted">Connections are unavailable.</p>
        )}
        {connection?.installations.map((item) => (
          <ConnectionSettings
            key={item.installationId}
            installation={item}
            busy={busy}
            update={
              update.kind !== "idle" && update.installationId === item.installationId
                ? update
                : undefined
            }
            onReconnect={() => void connect(item.installationId)}
            onDisconnect={(onDisconnected) => void disconnect(item.installationId, onDisconnected)}
          />
        ))}
      </div>
      {loadError && (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <p role="alert" className="text-[13px] text-danger">
            {loadError}
          </p>
          <button type="button" onClick={() => void reload()} className={BUTTON}>
            Refresh connections
          </button>
        </div>
      )}
    </SettingsShell>
  );
}

function ConnectionSettings({
  installation,
  busy,
  update,
  onReconnect,
  onDisconnect,
}: {
  installation: GitHubInstallation;
  busy: boolean;
  update: Exclude<AccessUpdate, { kind: "idle" }> | undefined;
  onReconnect: () => void;
  onDisconnect: (onDisconnected: () => void) => void;
}) {
  const title = useId();
  const summary = useRef<HTMLElement>(null);
  const { status } = installation;

  return (
    <section aria-labelledby={title}>
      <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <GithubIcon className="size-4 shrink-0 text-ink-2" />
          <h2 id={title} className="min-w-0 wrap-anywhere font-medium text-[13px]">
            @{installation.accountLogin}
          </h2>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-x-4 gap-y-2">
          <span className={TROUBLE.has(status) ? "text-xs text-danger" : "text-xs text-muted"}>
            {STATUS[status]}
          </span>
          <a
            href={installationUrl(installation)}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`Manage access for ${installation.accountLogin}`}
            className={`inline-flex items-center gap-1.5 rounded text-xs text-ink-2 hover:text-ink ${FOCUS}`}
          >
            Manage access
            <ExternalIcon className="size-3 text-muted" />
          </a>
        </div>
      </header>
      <details className="group border-edge/25 border-t">
        <summary
          ref={summary}
          className="flex min-h-10 cursor-pointer list-none items-center justify-between gap-2 px-4 text-[13px] text-ink-2 hover:bg-hover hover:text-ink focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent [&::-webkit-details-marker]:hidden"
        >
          Connection settings
          <ChevronRight className="size-3.5 text-muted group-open:rotate-90" />
        </summary>
        <dl className="divide-y divide-edge/25 border-edge/25 border-t text-[13px]">
          {[
            [
              "Account type",
              installation.accountType === "Organization" ? "Organization" : "Personal account",
            ],
            ["Connected by", `@${installation.githubLogin}`],
            ["Pull request author", "Nap GitHub App"],
            ["Review feedback", "Always asks"],
          ].map(([term, value]) => (
            <div key={term} className="flex items-center justify-between gap-4 px-4 py-2">
              <dt className="text-muted">{term}</dt>
              <dd className="min-w-0 wrap-anywhere text-right text-ink-2">{value}</dd>
            </div>
          ))}
        </dl>
        {status !== "active" && (
          <div className="flex items-center justify-between gap-3 border-edge/25 border-t px-4 py-2">
            <p className="text-xs text-muted">{RECONNECT[status]}</p>
            <button type="button" disabled={busy} onClick={onReconnect} className={BUTTON}>
              Reconnect
            </button>
          </div>
        )}
        {status !== "disconnected" && (
          <div className="flex items-center justify-between gap-3 border-edge/25 border-t px-4 py-2">
            <p className="text-xs text-muted">
              Disconnecting removes Nap's access to these repositories.
            </p>
            <button
              type="button"
              aria-disabled={busy}
              onClick={(event) => {
                if (busy) return;
                const button = event.currentTarget;
                onDisconnect(() => {
                  if (document.activeElement === button) summary.current?.focus();
                });
              }}
              className={`h-7 shrink-0 rounded-md px-2 text-xs text-danger hover:bg-danger/10 aria-disabled:opacity-50 ${FOCUS}`}
            >
              Disconnect
            </button>
          </div>
        )}
      </details>
      {update && (
        <div className="border-edge/25 border-t px-4 py-2">
          <AccessFeedback update={update} />
        </div>
      )}
    </section>
  );
}

function AccessFeedback({ update }: { update: Exclude<AccessUpdate, { kind: "idle" }> }) {
  return update.kind === "failed" ? (
    <p role="alert" className="text-[13px] text-danger">
      {update.error}
    </p>
  ) : (
    <p role="status" className="text-[13px] text-muted">
      Updating GitHub access…
    </p>
  );
}
