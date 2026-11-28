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
import { TROUBLE } from "../github/connections.tsx";
import { GITHUB_API_URL, githubRequest } from "../github/request.ts";
import { ChevronRight, GithubIcon, KeyIcon } from "../ui/icons.tsx";
import { SettingsShell } from "./settings-shell.tsx";
import { Card, ROW_BUTTON, Section } from "./settings-ui.tsx";

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
      draftId={draftId}
      onApiKey={() => setKeyOpen(true)}
    >
      <h1 className="text-xl font-medium tracking-tight text-ink">Connections</h1>
      <Section title="Git providers">
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

      <Section title="Model providers">
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
