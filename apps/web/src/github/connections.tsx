"use client";

/**
 * The GitHub page of Connections: the accounts nap's App is installed on, and a way to add one.
 *
 * Each account opens a drawer with its access and its repositories. Importing a repository is
 * not done here — the dashboard's new-session composer is where a repository becomes a
 * workspace, so this page only manages what nap can reach.
 */

import { GitHubConnectionsSchema, GitHubConnectResponseSchema } from "@nap/shared/github-protocol";
import { useCallback, useEffect, useState } from "react";
import { z } from "zod";
import { credentialedFetch } from "../api/credentialed-fetch.ts";
import type { FetchJson } from "../files/use-project-files.ts";
import { SettingsShell } from "../settings/settings-shell.tsx";
import {
  BackLink,
  BUTTON,
  Callout,
  Card,
  PRIMARY_BUTTON,
  ROW_BUTTON,
  Row,
  Section,
} from "../settings/settings-ui.tsx";
import { ChevronRight, ExternalIcon, GithubIcon, PlusIcon } from "../ui/icons.tsx";
import { ConnectionDrawer, STATUS, TROUBLE } from "./connection-drawer.tsx";
import { GITHUB_API_URL, githubRequest } from "./request.ts";

const disconnectSchema = z.object({ disconnected: z.literal(true) });
const navigateTo = (url: string) => window.location.assign(url);
const GITHUB_APPS_DOCS =
  "https://docs.github.com/en/apps/using-github-apps/reviewing-and-modifying-installed-github-apps";

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
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [openId, setOpenId] = useState<number>();

  const reload = useCallback(async () => {
    const result = await githubRequest(
      fetchJson,
      `${baseUrl}/github/connections`,
      GitHubConnectionsSchema,
    );
    if (result.ok) {
      setConnection(result.value);
      setError(undefined);
    } else setError(result.error);
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
    setBusy(true);
    setError(undefined);
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
    else {
      setError(result.error);
      setBusy(false);
    }
  };

  const disconnect = async (installationId: number) => {
    setBusy(true);
    setError(undefined);
    const result = await githubRequest(
      fetchJson,
      `${baseUrl}/github/installations/${installationId}`,
      disconnectSchema,
      { method: "DELETE" },
    );
    if (result.ok) {
      // Only this connection's drawer: it may have been closed while the request was out, and
      // another one opened in its place.
      setOpenId((current) => (current === installationId ? undefined : current));
      await reload();
    } else setError(result.error);
    setBusy(false);
  };

  const draft = draftId ? `?draft=${draftId}` : "";
  const appHref = draftId ? `/dashboard?draft=${draftId}&repositories=1` : "/dashboard";
  const open = connection?.installations.find((item) => item.installationId === openId);

  return (
    <SettingsShell
      crumbs={[
        { label: "Settings" },
        { label: "Connections", href: `/settings/connections${draft}` },
        { label: "GitHub" },
      ]}
      appHref={appHref}
      connectionsHref={`/settings/connections${draft}`}
      nested
    >
      <BackLink href={`/settings/connections${draft}`}>Back to Connections</BackLink>
      <div className="mx-auto mt-8 max-w-[720px]">
        <h1 className="flex items-center gap-2.5 text-lg font-medium text-ink">
          <GithubIcon className="size-5" />
          GitHub
        </h1>
        <p className="mt-1.5 text-[13px] text-muted">
          Let nap work in your repositories. Pull requests stay yours to review and merge.{" "}
          <a
            href={GITHUB_APPS_DOCS}
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent-ink underline-offset-4 hover:underline"
          >
            Documentation
          </a>
        </p>

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

        <Section
          title="Connections"
          description="Integrate nap with GitHub"
          action={
            connection?.configured && (
              <button
                type="button"
                className={PRIMARY_BUTTON}
                disabled={busy}
                onClick={() => void connect()}
              >
                <PlusIcon className="size-3.5" />
                Add connection
              </button>
            )
          }
        >
          <Card>
            {!connection && !error && (
              <p role="status" className="px-5 py-4 text-[13px] text-muted">
                Loading connections…
              </p>
            )}
            {connection?.configured === false && (
              <p className="px-5 py-4 text-[13px] leading-relaxed text-ink-2">
                GitHub is not configured for this nap deployment yet. The deployment administrator
                needs to register the GitHub App and configure its credentials.
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
            {error && !connection && (
              <p className="px-5 py-4 text-[13px] text-muted">Connections are unavailable.</p>
            )}
            {connection?.installations.map((item) => (
              <button
                key={item.installationId}
                type="button"
                onClick={() => {
                  // A drawer shows only what happens inside it, not the page's last failure.
                  setError(undefined);
                  setOpenId(item.installationId);
                }}
                className={ROW_BUTTON}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-ink">@{item.accountLogin}</span>
                  <span className="mt-0.5 block text-[13px] text-muted">
                    github.com
                    {item.status !== "active" && (
                      <>
                        {" · "}
                        <span className={TROUBLE.has(item.status) ? "text-danger" : undefined}>
                          {STATUS[item.status]}
                        </span>
                      </>
                    )}
                  </span>
                </span>
                <ChevronRight className="size-4 shrink-0 text-muted" />
              </button>
            ))}
          </Card>
          {error && !open && (
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <p role="alert" className="text-[13px] text-danger">
                {error}
              </p>
              <button type="button" onClick={() => void reload()} className={BUTTON}>
                Refresh connections
              </button>
            </div>
          )}
          {busy && !open && (
            <p role="status" className="mt-3 text-[13px] text-muted">
              Updating GitHub access…
            </p>
          )}
        </Section>

        {connection?.configured && (
          <Section title="General" description="How nap acts on GitHub">
            <Card>
              <Row
                title="Pull request author"
                description="Pull requests open as the nap GitHub App. Your own GitHub authorization only proves access, and is revoked straight after."
              >
                <span className="text-[13px] text-ink-2">GitHub App</span>
              </Row>
              <Row
                title="Review feedback"
                description="Comments on nap's pull requests wait for your approval before nap acts on them."
              >
                <span className="text-[13px] text-ink-2">Always asks</span>
              </Row>
            </Card>
            <a
              href="https://github.com/settings/installations"
              target="_blank"
              rel="noopener noreferrer"
              className="mt-3 inline-flex items-center gap-1.5 px-3 text-[13px] text-muted transition-colors hover:text-ink"
            >
              Manage installations on GitHub
              <ExternalIcon className="size-3.5" />
            </a>
          </Section>
        )}
      </div>

      {open && (
        <ConnectionDrawer
          installation={open}
          busy={busy}
          error={error}
          fetchJson={fetchJson}
          baseUrl={baseUrl}
          onClose={() => setOpenId(undefined)}
          onReconnect={() => void connect(open.installationId)}
          onDisconnect={() => void disconnect(open.installationId)}
        />
      )}
    </SettingsShell>
  );
}
