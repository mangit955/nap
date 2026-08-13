/**
 * Where somebody puts the key that buys the good models.
 *
 * Pure, like `SignInForm`: every state worth asserting — nothing saved, a key already there, a
 * rejected paste, a save in flight — is one prop away with no network and no router.
 *
 * **It never displays a key.** A saved key shows as the hint the server sends back, and the
 * field is emptied the moment a save succeeds. There is deliberately no "show what I saved":
 * the server could not answer that if it wanted to, and a form that could would leak the key
 * into every screen-share and browser cache the page passes through.
 *
 * The tone is an offer rather than a requirement, because it is one. Whoever is reading this
 * already has a working app on the free models; what a key adds is Opus and the paid GPT
 * models, and saying so is more honest than a form that implies nothing works without it.
 */

import { useState } from "react";

export type KeyState =
  | { configured: false }
  | { configured: true; platform: "openrouter" | "anthropic"; hint: string };

export type ApiKeyFormProps = {
  state: KeyState;
  onSave: (apiKey: string) => void;
  onRemove: () => void;
  /** In words, for the person who just tried. Undefined when nothing has gone wrong. */
  error?: string | undefined;
  busy?: boolean;
};

/** Where each key comes from, for somebody who does not have one yet. */
const WHERE: Record<"openrouter" | "anthropic", { name: string; url: string }> = {
  openrouter: { name: "OpenRouter", url: "https://openrouter.ai/settings/keys" },
  anthropic: { name: "Anthropic", url: "https://console.anthropic.com/settings/keys" },
};

const FIELD =
  "w-full rounded-[10px] border border-[var(--s-border-1)] bg-[var(--s-surface-1)] px-3.5 py-2.5 " +
  "text-[16px] text-[var(--s-text-primary)] outline-none placeholder:text-[var(--s-text-subtle)] " +
  "focus-visible:border-[var(--s-text-subtle)] focus-visible:outline focus-visible:outline-2 " +
  "focus-visible:outline-[var(--s-text-primary)] focus-visible:outline-offset-1";

const PILL =
  "rounded-full px-5 py-2.5 font-medium text-sm transition-opacity focus-visible:outline " +
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--s-text-primary)] " +
  "disabled:opacity-50";

export function ApiKeyForm({ state, onSave, onRemove, error, busy = false }: ApiKeyFormProps) {
  const [apiKey, setApiKey] = useState("");

  if (state.configured) {
    return (
      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between gap-4 rounded-[10px] border border-[var(--s-border-1)] bg-[var(--s-surface-2)] px-3.5 py-3">
          <div className="min-w-0">
            <p className="font-medium text-[var(--s-text-primary)] text-sm">
              {WHERE[state.platform].name}
            </p>
            {/* The whole of what anyone is ever shown of their own key. */}
            <p className="truncate font-mono text-[var(--s-text-muted)] text-xs">{state.hint}</p>
          </div>
          <button
            type="button"
            onClick={onRemove}
            disabled={busy}
            className={`${PILL} shrink-0 border border-[var(--s-border-1)] text-[var(--s-text-body)] hover:border-[var(--s-text-subtle)]`}
          >
            Remove
          </button>
        </div>

        {error !== undefined && (
          <p role="alert" className="text-[var(--color-danger)] text-xs leading-relaxed">
            {error}
          </p>
        )}

        <p className="text-[var(--s-text-muted)] text-xs leading-relaxed">
          Turns are billed to this key. Remove it and you go back to the free models.
        </p>
      </div>
    );
  }

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        onSave(apiKey);
      }}
    >
      <label className="flex flex-col gap-1.5">
        <span className="font-medium text-[var(--s-text-body)] text-xs">API key</span>
        <input
          // A password field: this is a credential, and a browser that offers to remember it or
          // a screen-share that catches it are both worse than one extra paste later.
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder="sk-or-…"
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
          className={FIELD}
        />
      </label>

      {error !== undefined && (
        <p role="alert" className="text-[var(--color-danger)] text-xs leading-relaxed">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={busy || apiKey.trim() === ""}
        className={`${PILL} bg-[var(--s-text-primary)] text-[var(--s-text-inverse)] hover:opacity-90`}
      >
        {busy ? "Checking…" : "Save key"}
      </button>

      <p className="text-[var(--s-text-muted)] text-xs leading-relaxed">
        Get one from{" "}
        <a
          href={WHERE.openrouter.url}
          target="_blank"
          rel="noreferrer"
          className="underline underline-offset-4"
        >
          OpenRouter
        </a>{" "}
        — where you can also cap what it is allowed to spend — or use an{" "}
        <a
          href={WHERE.anthropic.url}
          target="_blank"
          rel="noreferrer"
          className="underline underline-offset-4"
        >
          Anthropic
        </a>{" "}
        key for the Claude models. It is stored encrypted and never shown again.
      </p>
    </form>
  );
}
