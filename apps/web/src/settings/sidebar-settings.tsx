"use client";

/**
 * Settings → Sidebar: when the reaper may settle a session on its owner's behalf. Both rules are
 * off until turned on here; neither ever touches a pinned session or one that is working, and a
 * session somebody takes back out of Settled stays out until something new happens in it.
 */

import {
  AUTO_SETTLE_MAX_DAYS,
  type AutoSettleSettings,
  AutoSettleSettingsSchema,
} from "@nap/shared/session-navigation";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { credentialedFetch } from "../api/credentialed-fetch.ts";
import { authClient } from "../auth/client.ts";
import type { FetchJson } from "../files/use-project-files.ts";
import { GITHUB_API_URL, githubRequest } from "../github/request.ts";
import { SettingsShell } from "./settings-shell.tsx";
import { Card, FOCUS, Row, Section } from "./settings-ui.tsx";

/** What "after days" starts at when somebody turns it on. */
const DEFAULT_DAYS = 7;

export function LiveSidebarSettings() {
  const { data, isPending } = authClient.useSession();
  const router = useRouter();
  useEffect(() => {
    if (!isPending && !data) router.replace("/sign-in");
  }, [data, isPending, router]);
  if (!data) return <main role="status">Loading settings…</main>;
  return (
    <SettingsShell crumbs={[{ label: "Settings" }, { label: "Sidebar" }]} activePage="sidebar">
      <h1 className="text-xl font-medium">Sidebar</h1>
      <SidebarSettings />
    </SettingsShell>
  );
}

export function SidebarSettings({
  fetchJson = credentialedFetch,
  baseUrl = GITHUB_API_URL,
}: {
  fetchJson?: FetchJson;
  baseUrl?: string;
}) {
  const url = `${baseUrl}/sessions/auto-settle`;
  const [saved, setSaved] = useState<AutoSettleSettings>();
  const [days, setDays] = useState(String(DEFAULT_DAYS));
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let live = true;
    void githubRequest(fetchJson, url, AutoSettleSettingsSchema).then((result) => {
      if (!live) return;
      if (!result.ok) return setError(result.error);
      setSaved(result.value);
      if (result.value.afterDays !== null) setDays(String(result.value.afterDays));
    });
    return () => {
      live = false;
    };
  }, [fetchJson, url]);

  async function save(next: AutoSettleSettings) {
    setSaving(true);
    setError(undefined);
    const result = await githubRequest(fetchJson, url, AutoSettleSettingsSchema, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(next),
    });
    setSaving(false);
    if (!result.ok) return setError(result.error);
    setSaved(result.value);
  }

  /** The typed number, if it is one the server would take. */
  function parsedDays(): number | null {
    const value = Number(days);
    return Number.isInteger(value) && value >= 1 && value <= AUTO_SETTLE_MAX_DAYS ? value : null;
  }

  if (!saved)
    return error ? (
      <p role="alert" className="mt-6 text-sm text-danger">
        {error}
      </p>
    ) : (
      <p role="status" className="mt-6 text-sm text-muted">
        Loading settings…
      </p>
    );

  const afterOn = saved.afterDays !== null;
  return (
    <Section
      title="Auto-settle"
      description="Move sessions to Settled for you. Pinned and working sessions are never moved, and a session you un-settle stays put until something new happens in it."
    >
      <Card>
        <Row
          title={
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={afterOn}
                disabled={saving}
                onChange={(event) => {
                  const value = parsedDays() ?? DEFAULT_DAYS;
                  setDays(String(value));
                  void save({ ...saved, afterDays: event.target.checked ? value : null });
                }}
              />
              Settle sessions with no activity
            </label>
          }
          description="Counted from the last message, turn or pull request feedback."
        >
          <label className="flex items-center gap-2 text-[13px] text-ink-2">
            after
            <input
              type="number"
              inputMode="numeric"
              min={1}
              max={AUTO_SETTLE_MAX_DAYS}
              aria-label="Days without activity"
              value={days}
              disabled={!afterOn || saving}
              onChange={(event) => setDays(event.target.value)}
              onBlur={() => {
                const value = parsedDays();
                if (value === null) {
                  setDays(String(saved.afterDays ?? DEFAULT_DAYS));
                  setError(`Choose between 1 and ${AUTO_SETTLE_MAX_DAYS} days.`);
                  return;
                }
                if (value !== saved.afterDays) void save({ ...saved, afterDays: value });
              }}
              className={`h-8 w-16 rounded-lg border border-edge bg-field px-2 text-ink ${FOCUS}`}
            />
            days
          </label>
        </Row>
        <div className="border-t border-edge" />
        <Row
          title={
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={saved.onMerge}
                disabled={saving}
                onChange={(event) => void save({ ...saved, onMerge: event.target.checked })}
              />
              Settle a session when its pull request merges
            </label>
          }
          description="Only for sessions imported from GitHub, and only when the merge came after the session's last turn."
        />
      </Card>
      {error && (
        <p role="alert" className="mt-3 text-sm text-danger">
          {error}
        </p>
      )}
    </Section>
  );
}
