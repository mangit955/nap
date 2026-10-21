"use client";

/**
 * One GitHub connection, in a drawer over the GitHub page: its access and details on one tab,
 * the repositories it reaches on the other.
 *
 * **A real `<dialog>` opened with `showModal`**, for the reasons `ApiKeyPanel` gives: focus is
 * trapped inside, Escape closes, and the page behind is inert. Every way of closing — Escape,
 * the backdrop, ✕, the breadcrumb — goes through the element's own `close()`, so the parent
 * hears about it from one `close` event and unmounts it.
 */

import {
  type GitHubInstallation,
  GitHubRepositoriesSchema,
  type GitHubRepository,
} from "@nap/shared/github-protocol";
import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { relativeTime } from "../dashboard/relative-time.ts";
import type { FetchJson } from "../files/use-project-files.ts";
import { Badge, BUTTON, Card, DANGER_BUTTON, Row, Section } from "../settings/settings-ui.tsx";
import { CloseIcon, ExternalIcon, GithubIcon, ReloadIcon, SearchIcon } from "../ui/icons.tsx";
import { githubRequest } from "./request.ts";

export const STATUS = {
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
const TABS = [
  { id: "general", label: "General" },
  { id: "repositories", label: "Repositories" },
] as const;
type Tab = (typeof TABS)[number]["id"];

export function installationUrl(item: GitHubInstallation): string {
  return item.accountType === "Organization"
    ? `https://github.com/organizations/${encodeURIComponent(item.accountLogin)}/settings/installations/${item.installationId}`
    : `https://github.com/settings/installations/${item.installationId}`;
}

export function ConnectionDrawer({
  installation,
  busy,
  error,
  fetchJson,
  baseUrl,
  onClose,
  onReconnect,
  onDisconnect,
}: {
  installation: GitHubInstallation;
  busy: boolean;
  error: string | undefined;
  fetchJson: FetchJson;
  baseUrl: string;
  onClose: () => void;
  onReconnect: () => void;
  onDisconnect: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [tab, setTab] = useState<Tab>("general");
  // The repository list is fetched the first time its tab is shown, then kept across switches.
  const [visited, setVisited] = useState(false);
  const id = useId();

  useEffect(() => {
    const element = dialog.current;
    if (element !== null && !element.open) element.showModal();
  }, []);

  const close = () => dialog.current?.close();
  const select = (next: Tab) => {
    setTab(next);
    if (next === "repositories") setVisited(true);
  };
  const arrows = (event: KeyboardEvent) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    const next = tab === "general" ? "repositories" : "general";
    select(next);
    document.getElementById(`${id}-${next}-tab`)?.focus();
  };
  const login = `@${installation.accountLogin}`;

  return (
    <dialog
      ref={dialog}
      aria-labelledby={`${id}-title`}
      closedby="any"
      onClose={onClose}
      className="nap-sheet m-0 ml-auto h-dvh max-h-none w-full max-w-2xl border-l border-edge bg-panel p-0 text-ink shadow-raised backdrop:bg-black/55 open:flex open:flex-col"
    >
      <div className="flex h-11 shrink-0 items-center justify-between gap-3 px-5 sm:px-6">
        <p className="flex min-w-0 items-center gap-2 text-[13px]">
          <button
            type="button"
            onClick={close}
            className="rounded text-ink-2 transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
          >
            Connections
          </button>
          <span aria-hidden="true" className="text-line-strong">
            /
          </span>
          <span className="flex min-w-0 items-center gap-1.5 text-ink">
            <GithubIcon className="size-3.5 shrink-0" />
            <span className="truncate">{login}</span>
          </span>
        </p>
        <button
          type="button"
          onClick={close}
          aria-label="Close"
          className="-mr-1.5 flex size-8 shrink-0 items-center justify-center rounded-full text-muted transition-colors hover:bg-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
        >
          <CloseIcon className="size-4" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-12 pt-5 sm:px-6">
        <h2 id={`${id}-title`} className="flex items-center gap-2.5 text-lg font-medium">
          <GithubIcon className="size-5 shrink-0" />
          <span className="truncate">{login}</span>
        </h2>
        <p className="mt-0.5 text-[13px] text-muted">GitHub</p>

        <div
          role="tablist"
          aria-label="Connection settings"
          onKeyDown={arrows}
          className="mt-6 flex gap-1"
        >
          {TABS.map((item) => (
            <button
              key={item.id}
              id={`${id}-${item.id}-tab`}
              type="button"
              role="tab"
              aria-selected={tab === item.id}
              aria-controls={`${id}-${item.id}-panel`}
              tabIndex={tab === item.id ? 0 : -1}
              onClick={() => select(item.id)}
              className={`h-7 rounded-md px-2.5 text-[13px] transition-colors focus-visible:outline-2 focus-visible:outline-accent ${tab === item.id ? "bg-hover text-ink" : "text-muted hover:text-ink"}`}
            >
              {item.label}
            </button>
          ))}
        </div>

        <div
          role="tabpanel"
          id={`${id}-general-panel`}
          aria-labelledby={`${id}-general-tab`}
          hidden={tab !== "general"}
        >
          <Section level={3} title="Access" className="mt-6">
            <Card>
              <Row
                title="Repository access"
                description="Follows the repositories selected for the App on GitHub"
              >
                <a
                  href={installationUrl(installation)}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={`Manage access for ${installation.accountLogin}`}
                  className={BUTTON}
                >
                  Manage
                  <ExternalIcon className="size-3.5" />
                </a>
              </Row>
              {installation.status !== "active" && (
                <Row title="Reconnect" description={RECONNECT[installation.status]}>
                  <button type="button" disabled={busy} onClick={onReconnect} className={BUTTON}>
                    Reconnect
                  </button>
                </Row>
              )}
            </Card>
          </Section>

          <Section level={3} title="Details" className="mt-8">
            <Card>
              <dl className="px-5 py-1.5">
                {[
                  [
                    "Account type",
                    installation.accountType === "Organization"
                      ? "Organization"
                      : "Personal account",
                  ],
                  ["Connected by", `@${installation.githubLogin}`],
                  ["Status", STATUS[installation.status]],
                ].map(([term, value]) => (
                  <div key={term} className="flex items-center justify-between gap-4 py-2.5">
                    <dt className="text-sm text-ink">{term}</dt>
                    <dd
                      className={`truncate text-[13px] ${term === "Status" && TROUBLE.has(installation.status) ? "text-danger" : "text-ink-2"}`}
                    >
                      {value}
                    </dd>
                  </div>
                ))}
              </dl>
            </Card>
          </Section>

          {installation.status !== "disconnected" && (
            <Section level={3} title="Danger zone" className="mt-8">
              <Card>
                <Row
                  title="Disconnect connection"
                  description="Stop nap using this connection. To remove the App from GitHub, use Manage."
                >
                  <button
                    type="button"
                    disabled={busy}
                    onClick={onDisconnect}
                    className={DANGER_BUTTON}
                  >
                    Disconnect connection
                  </button>
                </Row>
              </Card>
            </Section>
          )}
          {busy && (
            <p role="status" className="mt-4 text-[13px] text-muted">
              Updating GitHub access…
            </p>
          )}
          {error && (
            <p role="alert" className="mt-4 text-[13px] text-danger">
              {error}
            </p>
          )}
        </div>

        {visited && (
          <div
            role="tabpanel"
            id={`${id}-repositories-panel`}
            aria-labelledby={`${id}-repositories-tab`}
            hidden={tab !== "repositories"}
          >
            <Repositories installation={installation} fetchJson={fetchJson} baseUrl={baseUrl} />
          </div>
        )}
      </div>
    </dialog>
  );
}

function Repositories({
  installation,
  fetchJson,
  baseUrl,
}: {
  installation: GitHubInstallation;
  fetchJson: FetchJson;
  baseUrl: string;
}) {
  const active = installation.status === "active";
  const [repositories, setRepositories] = useState<GitHubRepository[]>();
  const [fetchedAt, setFetchedAt] = useState<number>();
  const [loading, setLoading] = useState(active);
  const [error, setError] = useState<string>();
  const [query, setQuery] = useState("");
  const [attempt, setAttempt] = useState(0);
  // Re-render now and then so "Last fetched" does not say "just now" for the rest of the visit.
  const [, setTick] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => setTick((value) => value + 1), 30_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    void attempt;
    if (!active) return;
    let live = true;
    setLoading(true);
    setError(undefined);
    void githubRequest(
      fetchJson,
      `${baseUrl}/github/installations/${installation.installationId}/repositories`,
      GitHubRepositoriesSchema,
    ).then((result) => {
      if (!live) return;
      if (result.ok) {
        setRepositories(
          [...result.value.repositories].sort((a, b) => a.fullName.localeCompare(b.fullName)),
        );
        setFetchedAt(Date.now());
      } else setError(result.error);
      setLoading(false);
    });
    return () => {
      live = false;
    };
  }, [active, installation.installationId, fetchJson, baseUrl, attempt]);

  const needle = query.trim().toLowerCase();
  const shown = repositories?.filter((item) => item.fullName.toLowerCase().includes(needle)) ?? [];

  return (
    <>
      <Section
        level={3}
        title="Repositories"
        description="Repositories available through this connection"
        className="mt-6"
      >
        {active ? (
          <>
            <Card>
              <div className="flex items-center gap-2 border-b border-edge pl-3 pr-1.5">
                <SearchIcon className="size-3.5 shrink-0 text-muted" />
                <input
                  type="search"
                  aria-label="Search repositories"
                  placeholder="Search repositories…"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  className="h-10 min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-muted"
                />
                <button
                  type="button"
                  disabled={loading}
                  onClick={() => setAttempt((value) => value + 1)}
                  className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs text-muted transition-colors hover:bg-hover hover:text-ink disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-accent"
                >
                  <ReloadIcon className={`size-3.5 ${loading ? "motion-safe:animate-spin" : ""}`} />
                  Refetch repo list
                </button>
              </div>
              {error ? (
                <p role="alert" className="px-4 py-4 text-[13px] text-danger">
                  {error}
                </p>
              ) : repositories === undefined ? (
                <p role="status" className="px-4 py-6 text-center text-[13px] text-muted">
                  Loading repositories…
                </p>
              ) : repositories.length === 0 ? (
                <p className="px-4 py-6 text-center text-[13px] text-muted">
                  No repositories available. Choose repositories in Manage, then refetch.
                </p>
              ) : shown.length === 0 ? (
                <p className="px-4 py-6 text-center text-[13px] text-muted">
                  No repositories match “{query.trim()}”.
                </p>
              ) : (
                <ul aria-label="Repositories" className="max-h-72 overflow-y-auto p-1.5">
                  {shown.map((item) => (
                    <li key={item.id}>
                      <a
                        href={`https://github.com/${item.fullName}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center justify-between gap-3 rounded-md px-2.5 py-2 text-[13px] text-ink-2 transition-colors hover:bg-hover hover:text-ink focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
                      >
                        <span className="truncate">{item.fullName}</span>
                        {!item.private && <Badge>Public</Badge>}
                      </a>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
            {fetchedAt !== undefined && (
              <p className="mt-2 text-xs text-muted">
                Last fetched: {relativeTime(new Date(fetchedAt).toISOString())}
              </p>
            )}
          </>
        ) : (
          <Card>
            <p className="px-5 py-4 text-[13px] text-muted">
              Reconnect this connection to see its repositories.
            </p>
          </Card>
        )}
      </Section>

      <Section level={3} title="Installation" className="mt-8">
        <Card>
          <Row
            title="Add or remove repositories"
            description="Manage which repositories are installed on GitHub"
          >
            <a
              href={installationUrl(installation)}
              target="_blank"
              rel="noopener noreferrer"
              className={BUTTON}
            >
              Manage
              <ExternalIcon className="size-3.5" />
            </a>
          </Row>
        </Card>
      </Section>
    </>
  );
}
