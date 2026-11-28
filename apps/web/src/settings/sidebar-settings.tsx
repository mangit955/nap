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
import { useEffect, useRef, useState } from "react";
import { credentialedFetch } from "../api/credentialed-fetch.ts";
import { authClient } from "../auth/client.ts";
import type { FetchJson } from "../files/use-project-files.ts";
import { GITHUB_API_URL, githubRequest } from "../github/request.ts";
import { SettingsShell } from "./settings-shell.tsx";
import { FOCUS, Section } from "./settings-ui.tsx";

/** What "after days" starts at when somebody turns it on. */
const DEFAULT_DAYS = 7;

export function LiveSidebarSettings({ draftId }: { draftId?: string | undefined }) {
  const { data, isPending } = authClient.useSession();
  const router = useRouter();
  useEffect(() => {
    if (!isPending && !data) router.replace("/sign-in");
  }, [data, isPending, router]);
  if (!data) return <main role="status">Loading settings…</main>;
  return (
    <SettingsShell
      crumbs={[{ label: "Settings" }, { label: "Sidebar" }]}
      activePage="sidebar"
      draftId={draftId}
    >
      <h1 className="text-xl font-medium tracking-tight text-ink">Sidebar</h1>
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
  /**
   * What the controls last asked for, ahead of the server's answer, and the saves still on their
   * way, one after another. Each save builds on the one before it rather than on an answer still to
   * come, so nothing needs disabling while one is out: a blur that saves the days and the click
   * that caused it both land, instead of the second being lost to a disabled checkbox or undoing
   * the first.
   */
  const wanted = useRef<AutoSettleSettings | undefined>(undefined);
  const queue = useRef<Promise<void>>(Promise.resolve());

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

  function save(change: Partial<AutoSettleSettings>) {
    const base = wanted.current ?? saved;
    if (!base) return;
    const next = { ...base, ...change };
    wanted.current = next;
    setError(undefined);
    queue.current = queue.current.then(async () => {
      const result = await githubRequest(fetchJson, url, AutoSettleSettingsSchema, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(next),
      });
      if (result.ok) setSaved(result.value);
      else setError(result.error);
      // Settled with nothing behind it: the server's answer is what the controls show again.
      if (wanted.current === next) wanted.current = undefined;
    });
  }

  /** Saves the typed day count, or says why it cannot be saved — on blur, and on Enter. */
  function commitDays(current: AutoSettleSettings) {
    const value = parsedDays();
    if (value === null) {
      setDays(String(current.afterDays ?? DEFAULT_DAYS));
      setError(`Choose between 1 and ${AUTO_SETTLE_MAX_DAYS} days.`);
      return;
    }
    if (value !== (wanted.current ?? current).afterDays) save({ afterDays: value });
    else setError(undefined);
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
    <Section title="Auto-settle" description="Pinned and working sessions stay in the sidebar.">
      <div className="max-w-[520px] divide-y divide-edge/45 rounded-lg border border-edge/55 bg-panel/40">
        <div className="flex min-h-12 flex-wrap items-center justify-between gap-x-3 gap-y-2 px-3 py-2">
          <div>
            <p className="text-[13px]">After inactivity</p>
            <p className="text-xs text-muted">Since the last message, turn or PR update.</p>
          </div>
          <div className="ml-auto flex items-center gap-3">
            <label className="flex items-center gap-1.5 text-xs text-muted">
              <input
                type="number"
                inputMode="numeric"
                min={1}
                max={AUTO_SETTLE_MAX_DAYS}
                aria-label="Days without activity"
                value={days}
                disabled={!afterOn}
                onChange={(event) => setDays(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") commitDays(saved);
                }}
                onBlur={() => commitDays(saved)}
                className={`h-6 w-[30px] rounded-md border border-edge/55 bg-field px-0.5 text-center text-ink tabular-nums [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none disabled:opacity-45 ${FOCUS}`}
              />
              days
            </label>
            <Toggle
              label="Settle after inactivity"
              checked={afterOn}
              onChange={(checked) => {
                const value = parsedDays() ?? DEFAULT_DAYS;
                setDays(String(value));
                save({ afterDays: checked ? value : null });
              }}
            />
          </div>
        </div>
        <div className="flex min-h-12 items-center justify-between gap-3 px-3 py-2">
          <div>
            <p className="text-[13px]">After a pull request merges</p>
            <p className="text-xs text-muted">GitHub sessions only, after the last turn.</p>
          </div>
          <Toggle
            label="Settle after a pull request merges"
            checked={saved.onMerge}
            onChange={(checked) => save({ onMerge: checked })}
          />
        </div>
      </div>
      {error && (
        <p role="alert" className="mt-3 text-sm text-danger">
          {error}
        </p>
      )}
    </Section>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-label={label}
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`inline-flex h-4 w-7 shrink-0 cursor-pointer items-center rounded-full border p-[2px] transition-colors motion-reduce:transition-none ${checked ? "border-ink bg-ink" : "border-edge/55 bg-field"} ${FOCUS}`}
    >
      <span
        className={`size-2.5 rounded-full transition-transform motion-reduce:transition-none ${checked ? "translate-x-3 bg-surface" : "bg-muted"}`}
      />
    </button>
  );
}
