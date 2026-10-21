"use client";

/**
 * Every service nap can be connected to, one row each, with whether it is connected yet.
 *
 * Only providers nap actually supports are listed. Each row opens where that connection is
 * managed: GitHub has a page of its own, the model key is a dialog.
 */

import { GitHubConnectionsSchema } from "@nap/shared/github-protocol";
import { type ReactNode, useEffect, useId, useState } from "react";
import type { z } from "zod";
import { ApiKeyPanel } from "../account/api-key-panel.tsx";
import { useApiKey } from "../account/use-api-key.ts";
import { credentialedFetch } from "../api/credentialed-fetch.ts";
import type { FetchJson } from "../files/use-project-files.ts";
import { TROUBLE } from "../github/connection-drawer.tsx";
import { GITHUB_API_URL, githubRequest } from "../github/request.ts";
import { ChevronRight, GithubIcon, KeyIcon } from "../ui/icons.tsx";
import { SettingsShell } from "./settings-shell.tsx";
import { BackLink, Callout, Card, PRIMARY_BUTTON, ROW_BUTTON, Section } from "./settings-ui.tsx";

type GitHubState =
  | { kind: "loading" }
  | { kind: "failed" }
  | { kind: "loaded"; value: z.infer<typeof GitHubConnectionsSchema> };

const PLATFORM = { openrouter: "OpenRouter", anthropic: "Anthropic" };

export function ConnectionsOverview({
  fetchJson = credentialedFetch,
  baseUrl = GITHUB_API_URL,
  draftId,
}: {
  fetchJson?: FetchJson;
  baseUrl?: string;
  draftId?: string | undefined;
}) {
  const [github, setGithub] = useState<GitHubState>({ kind: "loading" });
  const [keyOpen, setKeyOpen] = useState(false);
  const key = useApiKey({ baseUrl, fetchJson });
  const draft = draftId ? `?draft=${draftId}` : "";
  const appHref = draftId ? `/dashboard?draft=${draftId}&repositories=1` : "/dashboard";

  useEffect(() => {
    let live = true;
    void githubRequest(fetchJson, `${baseUrl}/github/connections`, GitHubConnectionsSchema).then(
      (result) => {
        if (live)
          setGithub(result.ok ? { kind: "loaded", value: result.value } : { kind: "failed" });
      },
    );
    return () => {
      live = false;
    };
  }, [fetchJson, baseUrl]);

  const installations = github.kind === "loaded" ? github.value.installations : [];
  const accounts = installations.filter((item) => item.status === "active").length;
  const githubStatus =
    github.kind === "loading" ? (
      "Checking…"
    ) : github.kind === "failed" ? (
      <span className="text-danger">Could not load its status</span>
    ) : !github.value.configured ? (
      "Not available on this deployment"
    ) : accounts > 0 ? (
      <span className="text-ink-2">
        Connected · {accounts} {accounts === 1 ? "account" : "accounts"}
      </span>
    ) : installations.some((item) => TROUBLE.has(item.status)) ? (
      // Suspended or uninstalled on GitHub: not the same as never having connected.
      <span className="text-danger">Needs attention</span>
    ) : (
      "Not connected"
    );
  const keyStatus = key.state?.configured ? (
    <span className="text-ink-2">Connected · {key.state.hint}</span>
  ) : !key.loaded ? (
    "Checking…"
  ) : key.state === undefined ? (
    <span className="text-danger">Could not load its status</span>
  ) : (
    "Not connected"
  );

  return (
    <SettingsShell
      crumbs={[{ label: "Settings" }, { label: "Connections" }]}
      appHref={appHref}
      connectionsHref={`/settings/connections${draft}`}
      onApiKey={() => setKeyOpen(true)}
    >
      <BackLink href={appHref}>{draftId ? "Back to your draft" : "Back to workspace"}</BackLink>
      <div className="mx-auto mt-8 max-w-[720px]">
        <h1 className="text-lg font-medium text-ink">Connections</h1>
        <p className="mt-1 text-[13px] text-muted">
          Connect the services nap works with on your behalf.
        </p>

        <Callout
          title={draftId ? "Your draft is waiting" : "Repositories start from the dashboard"}
          action={
            <a href={appHref} className={PRIMARY_BUTTON}>
              {draftId ? "Back to draft" : "Open dashboard"}
            </a>
          }
        >
          Pick a connected repository in the new-session composer and nap opens it in a workspace of
          its own.
        </Callout>

        <p className="mt-6 inline-flex h-8 items-center gap-2 rounded-lg bg-hover px-2.5 text-[13px] text-ink">
          Integrations <span className="text-muted">2</span>
        </p>

        <Section title="Git providers" description="Let nap work on your codebase">
          <Card>
            <ProviderRow
              href={`/settings/connections/github${draft}`}
              icon={<GithubIcon className="size-5" />}
              name="GitHub"
              status={githubStatus}
              configure={accounts > 0}
            />
          </Card>
        </Section>

        <Section title="Model providers" description="Bring your own key for the paid models">
          <Card>
            <ProviderRow
              onClick={() => setKeyOpen(true)}
              icon={<KeyIcon className="size-5" />}
              name={key.state?.configured ? PLATFORM[key.state.platform] : "API key"}
              status={keyStatus}
              configure={key.state?.configured === true}
            />
          </Card>
        </Section>
      </div>
      <ApiKeyPanel open={keyOpen} onClose={() => setKeyOpen(false)} keyState={key} />
    </SettingsShell>
  );
}

function ProviderRow({
  href,
  onClick,
  icon,
  name,
  status,
  configure,
}: {
  href?: string;
  onClick?: () => void;
  icon: ReactNode;
  name: string;
  status: ReactNode;
  /** Connected rows say what clicking does; the rest let the chevron say it. */
  configure: boolean;
}) {
  const id = useId();
  // Named by the provider and described by its state, so a screen reader says "GitHub, link,
  // Connected" rather than running the two into one word.
  const label = { "aria-labelledby": `${id}-name`, "aria-describedby": `${id}-status` };
  const body = (
    <>
      <span className="flex size-8 shrink-0 items-center justify-center text-ink">{icon}</span>
      <span className="min-w-0 flex-1">
        <span id={`${id}-name`} className="block text-sm text-ink">
          {name}
        </span>
        <span id={`${id}-status`} className="mt-0.5 block truncate text-[13px] text-muted">
          {status}
        </span>
      </span>
      <span className="flex items-center gap-1 text-[13px] text-muted">
        {configure && "Configure"}
        <ChevronRight className="size-4" />
      </span>
    </>
  );
  return href ? (
    <a href={href} className={ROW_BUTTON} {...label}>
      {body}
    </a>
  ) : (
    <button type="button" onClick={onClick} className={ROW_BUTTON} {...label}>
      {body}
    </button>
  );
}
