"use client";

import {
  type RepositoryEnvironment,
  RepositoryEnvironmentSchema,
} from "@nap/shared/github-protocol";
import { useEffect, useState } from "react";

const INPUT =
  "mt-1.5 w-full rounded-lg border border-edge bg-field px-3 py-2 font-mono text-xs text-ink outline-none focus:border-accent disabled:opacity-50";

export function EnvironmentSettings({
  environment,
  busy,
  onSave,
  defaultExpanded = false,
}: {
  environment: RepositoryEnvironment;
  busy: boolean;
  onSave: (environment: RepositoryEnvironment) => Promise<boolean>;
  /** Open at once where the form is the only reason the surface was opened. */
  defaultExpanded?: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [changed, setChanged] = useState(false);
  const [setup, setSetup] = useState(environment.setupCommand ?? "");
  const [dev, setDev] = useState(environment.devCommand ?? "");
  const [port, setPort] = useState(environment.previewPort?.toString() ?? "");
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (changed) return;
    setSetup(environment.setupCommand ?? "");
    setDev(environment.devCommand ?? "");
    setPort(environment.previewPort?.toString() ?? "");
  }, [environment, changed]);

  const submit = async () => {
    const parsed = RepositoryEnvironmentSchema.safeParse({
      setupCommand: setup.trim() || null,
      devCommand: dev.trim() || null,
      previewPort: port === "" ? null : Number(port),
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Check the environment settings.");
      return;
    }
    setError(undefined);
    if (await onSave(parsed.data)) setChanged(false);
  };

  return (
    <section className="mt-5 rounded-xl border border-edge">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full items-center justify-between gap-3 rounded-xl px-4 py-3 text-left text-sm font-medium text-ink hover:bg-hover focus-visible:outline-accent"
      >
        Environment setup
        <span aria-hidden="true" className="text-muted">
          {expanded ? "−" : "+"}
        </span>
      </button>
      <form
        aria-label="Repository environment"
        hidden={!expanded}
        className="space-y-4 border-t border-edge p-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <p className="text-xs leading-relaxed text-muted">
          Changes apply on the next workspace start. Put the project away and reopen it after
          saving. You can correct a failed setup here without importing again.
        </p>
        <label className="block text-xs">
          Setup command
          <input
            className={INPUT}
            value={setup}
            disabled={busy}
            spellCheck={false}
            placeholder="bun install --frozen-lockfile"
            onChange={(event) => {
              setSetup(event.target.value);
              setChanged(true);
            }}
          />
        </label>
        <p className="text-xs leading-relaxed text-muted">
          Setup must leave tracked files unchanged. Use a frozen lockfile and add generated outputs
          to .gitignore. Leave empty to skip setup.
        </p>
        <label className="block text-xs">
          Development command
          <input
            className={INPUT}
            value={dev}
            disabled={busy}
            spellCheck={false}
            placeholder="npm run dev -- --host 0.0.0.0"
            onChange={(event) => {
              setDev(event.target.value);
              setChanged(true);
            }}
          />
        </label>
        <label className="block text-xs">
          Preview port
          <input
            className={INPUT}
            type="number"
            min={1024}
            max={65535}
            value={port}
            disabled={busy}
            placeholder="5173"
            onChange={(event) => {
              setPort(event.target.value);
              setChanged(true);
            }}
          />
        </label>
        <p className="text-xs leading-relaxed text-muted">
          Set both the development command and its port, or leave both empty for no preview. Bind
          the server to 0.0.0.0.
        </p>
        {error && (
          <p role="alert" className="text-xs text-danger">
            {error}
          </p>
        )}
        <button
          type="submit"
          disabled={busy}
          className="rounded-lg border border-edge px-3 py-2 text-xs font-medium text-ink hover:bg-hover disabled:opacity-50"
        >
          {busy ? "Saving…" : "Save environment"}
        </button>
      </form>
    </section>
  );
}
