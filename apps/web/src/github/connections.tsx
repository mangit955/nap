"use client";

import {
  GitHubConnectionsSchema,
  GitHubConnectResponseSchema,
  type GitHubInstallation,
  GitHubRepositoriesSchema,
  type GitHubRepository,
  RepositoryImportSchema,
} from "@nap/shared/github-protocol";
import { CreatedProjectSchema } from "@nap/shared/projects-protocol";
import { useCallback, useEffect, useState } from "react";
import { z } from "zod";
import { credentialedFetch } from "../api/credentialed-fetch.ts";
import { NapMark } from "../brand/nap-mark.tsx";
import type { FetchJson } from "../files/use-project-files.ts";
import { GITHUB_API_URL, githubRequest } from "./request.ts";

const BUTTON =
  "rounded-lg border border-edge bg-panel px-3 py-2 text-sm font-medium text-ink transition-colors hover:bg-hover disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-accent";
const INPUT =
  "mt-2 w-full rounded-lg border border-edge bg-field px-3 py-2.5 text-sm text-ink outline-none focus:border-accent disabled:opacity-50";
const disconnectSchema = z.object({ disconnected: z.literal(true) });
const navigateTo = (url: string) => window.location.assign(url);
const STATUS = {
  active: "Connected",
  suspended: "Suspended",
  removed: "Uninstalled",
  disconnected: "Disconnected",
};

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
    if (result.ok) await reload();
    else setError(result.error);
    setBusy(false);
  };
  const active = connection?.installations.filter((item) => item.status === "active") ?? [];

  return (
    <main className="min-h-dvh bg-surface px-5 py-8 text-ink sm:px-8 sm:py-12">
      <div className="mx-auto max-w-3xl">
        <a
          href={draftId ? `/dashboard?draft=${draftId}&repositories=1` : "/dashboard"}
          className="inline-flex items-center gap-2 text-sm text-muted hover:text-ink"
        >
          <NapMark className="size-6" /> Back to workspace
        </a>
        <header className="mb-8 mt-10">
          <p className="mb-2 text-xs font-medium uppercase tracking-[0.16em] text-muted">
            Settings
          </p>
          <h1 className="text-3xl font-medium tracking-tight">Connections</h1>
          <p className="mt-3 max-w-xl text-sm leading-relaxed text-ink-2">
            Choose the repositories nap can work on. GitHub repository access is separate from
            signing in and your model provider.
          </p>
        </header>

        {callbackStatus && (
          <p
            role={callbackStatus === "connected" ? "status" : "alert"}
            className={`mb-5 rounded-xl border border-edge bg-panel p-4 text-sm ${callbackStatus === "connected" ? "text-ink" : "text-danger"}`}
          >
            {callbackStatus === "connected"
              ? "GitHub connected. Choose a repository to import."
              : "The GitHub connection could not be completed. Reconnect to try again."}
          </p>
        )}

        <section
          aria-labelledby="github-title"
          className="rounded-2xl border border-edge bg-panel p-5 sm:p-6"
        >
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h2 id="github-title" className="text-lg font-medium">
                GitHub
              </h2>
              <p className="mt-1 text-sm text-muted">
                Install the nap GitHub App on your account or organization.
              </p>
            </div>
            {connection?.configured && (
              <button
                type="button"
                className={BUTTON}
                disabled={busy}
                onClick={() => void connect()}
              >
                Connect GitHub
              </button>
            )}
          </div>
          {!connection && !error && (
            <p role="status" className="mt-5 text-sm text-muted">
              Loading connections…
            </p>
          )}
          {connection?.configured === false && (
            <p className="mt-5 rounded-lg bg-field p-4 text-sm text-ink-2">
              GitHub is not configured for this nap deployment yet. The deployment administrator
              needs to register the GitHub App and configure its credentials.
            </p>
          )}
          {connection?.configured && connection.installations.length === 0 && (
            <p className="mt-5 text-sm text-muted">No GitHub connections yet.</p>
          )}
          <ul className="mt-5 space-y-3">
            {connection?.installations.map((item) => (
              <li key={item.installationId} className="rounded-xl border border-edge p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="font-medium">{item.accountLogin}</p>
                    <p className="mt-1 text-xs text-muted">
                      {item.accountType === "Organization" ? "Organization" : "Personal account"} ·{" "}
                      {STATUS[item.status]}
                    </p>
                  </div>
                  <span className="rounded-full border border-edge px-2.5 py-1 text-xs text-ink-2">
                    {STATUS[item.status]}
                  </span>
                </div>
                <p className="mt-3 text-xs leading-relaxed text-muted">
                  Connected by {item.githubLogin}. Repository access follows the App selection on
                  GitHub.
                </p>
                <div className="mt-4 flex flex-wrap gap-2">
                  <a
                    href={installationUrl(item)}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={`Manage access for ${item.accountLogin}`}
                    className={BUTTON}
                  >
                    Manage access
                  </a>
                  {item.status !== "active" && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void connect(item.installationId)}
                      className={BUTTON}
                    >
                      Reconnect {item.accountLogin}
                    </button>
                  )}
                  {item.status !== "disconnected" && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void disconnect(item.installationId)}
                      className={BUTTON}
                    >
                      Disconnect {item.accountLogin}
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
          {error && (
            <div className="mt-5">
              <p role="alert" className="text-sm text-danger">
                {error}
              </p>
              <button type="button" onClick={() => void reload()} className={`${BUTTON} mt-3`}>
                Refresh connections
              </button>
            </div>
          )}
          {busy && (
            <p role="status" className="mt-4 text-sm text-muted">
              Updating GitHub access…
            </p>
          )}
          <p className="mt-5 text-xs leading-relaxed text-muted">
            Disconnecting stops nap from using this connection. To remove the App from GitHub, use
            Manage access.
          </p>
        </section>

        {connection?.configured && active.length > 0 && (
          <RepositoryImport
            installations={active}
            baseUrl={baseUrl}
            fetchJson={fetchJson}
            navigate={navigate}
          />
        )}
      </div>
    </main>
  );
}

function installationUrl(item: GitHubInstallation): string {
  return item.accountType === "Organization"
    ? `https://github.com/organizations/${encodeURIComponent(item.accountLogin)}/settings/installations/${item.installationId}`
    : `https://github.com/settings/installations/${item.installationId}`;
}

function RepositoryImport({
  installations,
  baseUrl,
  fetchJson,
  navigate,
}: {
  installations: GitHubInstallation[];
  baseUrl: string;
  fetchJson: FetchJson;
  navigate: (url: string) => void;
}) {
  const [selectedInstallation, setSelectedInstallation] = useState(
    installations[0]?.installationId,
  );
  const installationId = installations.some((item) => item.installationId === selectedInstallation)
    ? selectedInstallation
    : installations[0]?.installationId;
  const [repositories, setRepositories] = useState<GitHubRepository[]>([]);
  const [repositoryId, setRepositoryId] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [branch, setBranch] = useState("");
  const [setup, setSetup] = useState("bun install --frozen-lockfile");
  const [dev, setDev] = useState("");
  const [port, setPort] = useState("");
  const [autoPublish, setAutoPublish] = useState(true);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    void revision;
    let live = true;
    setLoading(true);
    setRepositories([]);
    setRepositoryId("");
    setError(undefined);
    void githubRequest(
      fetchJson,
      `${baseUrl}/github/installations/${installationId}/repositories`,
      GitHubRepositoriesSchema,
    ).then((result) => {
      if (!live) return;
      if (result.ok) setRepositories(result.value.repositories);
      else setError(result.error);
      setLoading(false);
    });
    return () => {
      live = false;
    };
  }, [installationId, baseUrl, fetchJson, revision]);

  const submit = async () => {
    const request = RepositoryImportSchema.safeParse({
      installationId,
      repositoryId: Number(repositoryId),
      name,
      baseBranch: branch,
      environment: {
        setupCommand: setup.trim() || null,
        devCommand: dev.trim() || null,
        previewPort: port === "" ? null : Number(port),
      },
      autoPublish,
    });
    if (!request.success) {
      setError(request.error.issues[0]?.message ?? "Check the repository settings.");
      return;
    }
    setBusy(true);
    setError(undefined);
    const result = await githubRequest(
      fetchJson,
      `${baseUrl}/github/import`,
      CreatedProjectSchema,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request.data),
      },
    );
    if (result.ok) navigate(`/p/${result.value.projectId}`);
    else {
      setError(result.error);
      setBusy(false);
    }
  };

  return (
    <section
      aria-labelledby="import-title"
      id="import"
      className="mt-6 rounded-2xl border border-edge bg-panel p-5 sm:p-6"
    >
      <h2 id="import-title" className="text-lg font-medium">
        Import a repository
      </h2>
      <p className="mt-2 text-sm leading-relaxed text-muted">
        Start an isolated cloud workspace from an existing branch. Nap keeps its history and works
        on dedicated branches.
      </p>
      <form
        className="mt-6 space-y-5"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <label className="block text-sm">
          GitHub account
          <select
            className={INPUT}
            value={installationId ?? ""}
            disabled={busy}
            onChange={(event) => setSelectedInstallation(Number(event.target.value))}
          >
            {installations.map((item) => (
              <option key={item.installationId} value={item.installationId}>
                {item.accountLogin}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm">
          Repository
          <select
            className={INPUT}
            value={repositoryId}
            required
            disabled={busy || loading}
            onChange={(event) => {
              setRepositoryId(event.target.value);
              const repo = repositories.find((item) => String(item.id) === event.target.value);
              setName(repo?.fullName.split("/")[1] ?? "");
              setBranch(repo?.defaultBranch ?? "");
            }}
          >
            <option value="">{loading ? "Loading repositories…" : "Choose a repository"}</option>
            {repositories.map((item) => (
              <option key={item.id} value={item.id}>
                {item.fullName}
                {item.private ? " · private" : " · public"}
              </option>
            ))}
          </select>
        </label>
        {!loading && repositories.length === 0 && (
          <p className="text-sm text-muted">
            No repositories available. Choose repositories in Manage access, then refresh.
          </p>
        )}
        <button
          type="button"
          className="text-xs text-ink-2 underline underline-offset-4"
          disabled={busy || loading}
          onClick={() => setRevision((value) => value + 1)}
        >
          Refresh repositories
        </button>
        <div className="grid gap-5 sm:grid-cols-2">
          <label className="block text-sm">
            Project name
            <input
              className={INPUT}
              value={name}
              required
              maxLength={100}
              disabled={busy}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label className="block text-sm">
            Base branch
            <input
              className={INPUT}
              value={branch}
              required
              disabled={busy}
              spellCheck={false}
              onChange={(event) => setBranch(event.target.value)}
            />
          </label>
        </div>
        <fieldset className="space-y-4 rounded-xl border border-edge p-4">
          <legend className="px-2 text-sm font-medium">Environment setup</legend>
          <p className="text-xs leading-relaxed text-muted">
            Commands run inside the sandbox at the repository root. Choose commands supported by
            this repository. Setup runs on import and restore; leave it empty to skip dependency
            installation. Setup must leave tracked files unchanged. Use a frozen lockfile and add
            generated outputs to .gitignore.
          </p>
          <label className="block text-sm">
            Setup command
            <input
              className={`${INPUT} font-mono`}
              value={setup}
              disabled={busy}
              spellCheck={false}
              placeholder="npm ci"
              onChange={(event) => setSetup(event.target.value)}
            />
          </label>
          <label className="block text-sm">
            Development command
            <input
              className={`${INPUT} font-mono`}
              value={dev}
              disabled={busy}
              spellCheck={false}
              placeholder="npm run dev -- --host 0.0.0.0"
              onChange={(event) => setDev(event.target.value)}
            />
          </label>
          <label className="block text-sm">
            Preview port
            <input
              className={INPUT}
              type="number"
              min={1024}
              max={65535}
              value={port}
              disabled={busy}
              placeholder="5173"
              onChange={(event) => setPort(event.target.value)}
            />
          </label>
          <p className="text-xs leading-relaxed text-muted">
            A preview is optional. Set both the development command and its port, and bind the
            server to 0.0.0.0.
          </p>
        </fieldset>
        <label className="flex items-start gap-3 text-sm">
          <input
            type="checkbox"
            checked={autoPublish}
            disabled={busy}
            onChange={(event) => setAutoPublish(event.target.checked)}
            className="mt-0.5 accent-accent"
          />
          <span>
            Create a draft pull request after verified work
            <span className="mt-1 block text-xs leading-relaxed text-muted">
              Nap pushes its dedicated branch. You review and merge on GitHub. Feedback always waits
              for your approval.
            </span>
          </span>
        </label>
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        <button
          type="submit"
          disabled={busy || loading || !repositoryId}
          className="rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-white hover:bg-accent/90 disabled:opacity-50"
        >
          {busy ? "Importing…" : "Import repository"}
        </button>
      </form>
    </section>
  );
}
