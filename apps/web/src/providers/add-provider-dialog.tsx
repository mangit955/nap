"use client";

/**
 * Adding a Claude or ChatGPT account: T3 Code's "Add provider" wizard, in Nap's palette.
 *
 * Three steps, as T3's: which provider, what to call this account, and its configuration.
 * Finishing adds the account and starts sign-in when the deployment supports it.
 *
 * Codex keeps T3's shortcut on the first step: "Continue with ChatGPT" skips straight to signing
 * in, because most people adding it have one ChatGPT account and nothing to name.
 *
 * A real `<dialog>` opened with `showModal`, for the reasons `ApiKeyPanel` gives: focus is trapped
 * inside, Escape closes it, and the page behind is inert to everyone.
 *
 * Adapted from T3 Code (MIT); see `THIRD_PARTY_NOTICES.md`.
 */

import {
  CreateProviderAccountSchema,
  type ProviderAccountView,
  type ProviderDriver,
} from "@nap/shared/provider-accounts-protocol";
import { useEffect, useId, useRef, useState } from "react";
import { CheckIcon, CloseIcon } from "../ui/icons.tsx";
import { DRIVER_ORDER, DRIVERS } from "./drivers.tsx";
import { ACCENT_BUTTON, GHOST_BUTTON, INPUT, OUTLINE_BUTTON } from "./provider-settings-ui.tsx";
import type { Outcome } from "./use-provider-accounts.ts";

const STEPS = ["Provider", "Identity", "Config"] as const;

export function AddProviderDialog({
  open,
  onClose,
  signInAvailable,
  onCreate,
  onStartSignIn,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  signInAvailable: boolean;
  onCreate: (input: {
    driver: ProviderDriver;
    label?: string;
  }) => Promise<Outcome<ProviderAccountView>>;
  onStartSignIn: (id: string) => Promise<Outcome<unknown>>;
  /** Selects the new account in the list, so its editor is what the person sees next. */
  onCreated: (id: string, startError: string | null) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [step, setStep] = useState(0);
  const [driver, setDriver] = useState<ProviderDriver>("codex");
  const [label, setLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const id = useId();

  useEffect(() => {
    const element = dialog.current;
    if (element === null) return;
    if (open && !element.open) {
      // Every visit starts at the first step: a dialog reopened on step three with last time's
      // label in it would add an account the person did not mean to.
      setStep(0);
      setLabel("");
      setError(null);
      element.showModal();
    }
    if (!open && element.open) element.close();
  }, [open]);

  const labelError =
    label.trim() === ""
      ? null
      : CreateProviderAccountSchema.shape.label.safeParse(label).success
        ? null
        : "Keep it to 40 characters.";

  async function finish(withLabel: boolean) {
    if (saving || (withLabel && labelError !== null)) return;
    setSaving(true);
    setError(null);
    const trimmed = label.trim();
    const created = await onCreate({
      driver,
      ...(withLabel && trimmed !== "" ? { label: trimmed } : {}),
    });
    if (!created.ok) {
      setError(created.error);
      setSaving(false);
      return;
    }
    // The account exists whatever happens next. A sign-in that cannot start is reported on the
    // account's own row, where the button to retry it is, rather than holding this dialog open.
    const started = signInAvailable ? await onStartSignIn(created.value.id) : null;
    onCreated(created.value.id, started && !started.ok ? started.error : null);
    setSaving(false);
    onClose();
  }

  const copy = DRIVERS[driver];
  const finishLabel = signInAvailable ? copy.signIn : "Add provider";

  return (
    <dialog
      ref={dialog}
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-description`}
      closedby="any"
      onClose={onClose}
      className="nap-dialog m-auto w-full max-w-xl dialog-glass overflow-hidden rounded-[18px] border p-0 text-ink"
    >
      <div className="relative space-y-4 px-6 pt-6 pb-5">
        <div className="pr-8">
          <h2 id={`${id}-title`} className="font-semibold text-lg text-ink tracking-tight">
            Add provider
          </h2>
          <p id={`${id}-description`} className="mt-1 text-sm text-muted">
            Add an account or configure a provider on nap.
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="absolute top-4 right-4 flex size-8 items-center justify-center rounded-full text-muted transition-colors hover:bg-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          <CloseIcon className="size-4" />
        </button>
        <WizardSteps current={step} onStep={(next) => next < step && setStep(next)} />
      </div>

      <div className="min-h-44 border-edge border-t px-6 py-5">
        {step === 0 ? (
          <fieldset className="grid gap-2">
            <legend className="mb-2 text-sm font-medium text-ink">Provider</legend>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {DRIVER_ORDER.map((option) => {
                const checked = option === driver;
                return (
                  <label
                    key={option}
                    className={`relative flex cursor-pointer items-center gap-3 rounded-lg px-3 py-3 text-left ring-1 transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent ${checked ? "bg-accent-tint text-ink ring-2 ring-accent" : "bg-field text-muted ring-edge hover:bg-hover"}`}
                  >
                    <input
                      type="radio"
                      name={`${id}-driver`}
                      value={option}
                      checked={checked}
                      onChange={() => setDriver(option)}
                      className="sr-only"
                    />
                    {DRIVERS[option].icon("size-4 shrink-0 text-ink")}
                    <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">
                      {DRIVERS[option].name}
                    </span>
                    {checked ? (
                      <span
                        aria-hidden="true"
                        className="grid size-5 shrink-0 place-items-center rounded-full bg-accent text-white"
                      >
                        <CheckIcon className="size-3.5" />
                      </span>
                    ) : null}
                  </label>
                );
              })}
            </div>
            <p className="mt-2 text-xs text-muted">{copy.pitch}</p>
          </fieldset>
        ) : step === 1 ? (
          <div className="@container/settings-row">
            <div className="flex flex-col gap-3 @min-[32rem]/settings-row:grid @min-[32rem]/settings-row:grid-cols-[minmax(0,1fr)_auto] @min-[32rem]/settings-row:items-center @min-[32rem]/settings-row:gap-8">
              <div className="space-y-1">
                <label htmlFor={`${id}-label`} className="text-sm font-medium text-ink">
                  Label
                </label>
                <p id={`${id}-label-description`} className="text-xs text-muted">
                  Shown in the provider list.
                </p>
                {labelError ? (
                  <p role="alert" className="text-xs text-danger">
                    {labelError}
                  </p>
                ) : null}
              </div>
              <input
                id={`${id}-label`}
                aria-describedby={`${id}-label-description`}
                aria-invalid={labelError !== null}
                className={`${INPUT} w-full @min-[32rem]/settings-row:w-56`}
                placeholder="e.g. Work"
                value={label}
                onChange={(event) => setLabel(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && labelError === null) {
                    event.preventDefault();
                    setStep(2);
                  }
                }}
              />
            </div>
          </div>
        ) : (
          <div className="grid gap-3">
            <div className="flex items-center gap-2.5">
              {copy.icon("size-4 shrink-0 text-ink")}
              <span className="text-sm font-medium text-ink">
                {copy.name}
                {label.trim() ? ` · ${label.trim()}` : null}
              </span>
            </div>
            <p className="text-sm text-muted">
              {signInAvailable
                ? `This account is for ${copy.runtime}. Adding it doesn't start an agent.`
                : `${copy.runtime} runtime and sign-in aren't available on this deployment yet.`}
            </p>
            {!signInAvailable ? (
              <p className="rounded-lg border border-edge bg-field px-3 py-2.5 text-xs leading-relaxed text-muted">
                Signing in isn't available on this deployment yet. The account is added now and can
                sign in once it is.
              </p>
            ) : null}
          </div>
        )}
        {error ? (
          <p role="alert" className="mt-3 text-xs text-danger">
            {error}
          </p>
        ) : null}
      </div>

      <footer className="flex flex-col-reverse gap-2 border-edge border-t px-6 py-4 sm:flex-row sm:justify-end">
        <button
          type="button"
          disabled={saving}
          className={step === 0 ? GHOST_BUTTON : OUTLINE_BUTTON}
          onClick={() => (step === 0 ? onClose() : setStep(step - 1))}
        >
          {step === 0 ? "Cancel" : "Back"}
        </button>
        {step === 0 && driver === "codex" ? (
          <>
            <button type="button" className={OUTLINE_BUTTON} onClick={() => setStep(1)}>
              Configure manually
            </button>
            <button
              type="button"
              disabled={saving}
              className={ACCENT_BUTTON}
              onClick={() => void finish(false)}
            >
              {DRIVERS.codex.icon("size-3.5 shrink-0")}
              {signInAvailable ? DRIVERS.codex.signIn : "Add provider"}
            </button>
          </>
        ) : step < 2 ? (
          <button
            type="button"
            disabled={step === 1 && labelError !== null}
            className={ACCENT_BUTTON}
            onClick={() => setStep(step + 1)}
          >
            Next
          </button>
        ) : (
          <button
            type="button"
            disabled={saving}
            className={ACCENT_BUTTON}
            onClick={() => void finish(true)}
          >
            {signInAvailable ? copy.icon("size-3.5 shrink-0") : null}
            {saving ? "Adding…" : finishLabel}
          </button>
        )}
      </footer>
    </dialog>
  );
}

/** T3's `WizardSteps`: where the person is, and a way back to a step already done. */
function WizardSteps({ current, onStep }: { current: number; onStep: (step: number) => void }) {
  return (
    <ol
      aria-label="Setup progress"
      className="grid auto-cols-fr grid-flow-col gap-1 rounded-xl bg-field p-1 ring-1 ring-edge"
    >
      {STEPS.map((name, index) => (
        <li key={name} className="min-w-0">
          <button
            type="button"
            disabled={index >= current}
            aria-current={index === current ? "step" : undefined}
            aria-label={`${name}, step ${index + 1}`}
            onClick={() => onStep(index)}
            className={`flex w-full min-w-0 items-center gap-2 rounded-lg px-2.5 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent max-sm:justify-center max-sm:px-2 enabled:cursor-pointer enabled:hover:bg-panel ${index === current ? "bg-panel text-ink shadow-hairline" : ""}`}
          >
            <span
              aria-hidden="true"
              className={`grid size-5 shrink-0 place-items-center rounded-full text-xs font-medium ring-1 ${
                index < current
                  ? "bg-accent text-white ring-accent"
                  : index === current
                    ? "bg-accent-tint text-accent-ink ring-accent/30"
                    : "bg-panel text-muted ring-edge"
              }`}
            >
              {index < current ? <CheckIcon className="size-3.5" /> : index + 1}
            </span>
            <span
              className={`min-w-0 truncate text-sm font-medium max-sm:hidden ${index === current ? "text-ink" : "text-muted"}`}
            >
              {name}
            </span>
          </button>
        </li>
      ))}
    </ol>
  );
}
