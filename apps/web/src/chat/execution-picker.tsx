"use client";

import type { ExecutionSelection } from "@nap/shared/execution-target";
import type { ModelChoice } from "@nap/shared/models-protocol";
import type { SubscriptionCatalog } from "@nap/shared/subscription-protocol";

/** The account is part of the choice even when providers advertise identical model IDs. */
export function ExecutionPicker({
  models,
  fallback,
  accounts,
  selection,
  disabled = false,
  onChange,
}: {
  models: readonly ModelChoice[];
  fallback: string | undefined;
  accounts: SubscriptionCatalog["accounts"];
  selection: ExecutionSelection | null;
  disabled?: boolean;
  onChange: (selection: ExecutionSelection) => void;
}) {
  const choices: {
    value: string;
    label: string;
    disabled: boolean;
    selection: ExecutionSelection;
  }[] = [
    ...models.map((model) => ({
      value: JSON.stringify(["api", model.id]),
      label: `${model.label} · ${model.free ? "Free" : "API"}${model.available ? "" : " · needs your key"}`,
      disabled: !model.available,
      selection: { kind: "api", model: model.id } satisfies ExecutionSelection,
    })),
    ...accounts.flatMap(({ account, models: nativeModels, availability }) =>
      nativeModels.map((model) => ({
        value: JSON.stringify(["subscription", account.id, model.id]),
        label: `${account.label ?? (account.driver === "claude" ? "Claude Code" : "Codex")} · ${model.label}${model.supportsImages ? "" : " · Text only"}${availability === "ready" ? "" : ` · ${availability.replaceAll("_", " ")}`}`,
        // Saving an owned account awaiting sign-in is supported, but cannot send a turn.
        disabled: availability === "unavailable",
        selection: {
          kind: "subscription",
          accountId: account.id,
          model: model.id,
        } satisfies ExecutionSelection,
      })),
    ),
  ];
  const value =
    selection?.kind === "subscription"
      ? JSON.stringify(["subscription", selection.accountId, selection.model])
      : JSON.stringify(["api", selection?.model ?? fallback]);
  const known = choices.some((choice) => choice.value === value);
  return (
    <select
      aria-label="Account and model"
      value={value}
      disabled={disabled}
      onChange={(event) => {
        const choice = choices.find((item) => item.value === event.target.value);
        if (choice !== undefined && !choice.disabled) onChange(choice.selection);
      }}
      className="h-8 max-w-[240px] truncate rounded-lg border border-edge bg-surface px-2 text-[12px] text-ink-2 focus-visible:outline-accent disabled:text-muted"
    >
      {!known && (
        <option value={value} disabled>
          {selection?.kind === "subscription"
            ? "Selected subscription unavailable"
            : "Choose an account and model"}
        </option>
      )}
      <optgroup label="API models">
        {choices
          .filter((choice) => choice.selection.kind === "api")
          .map((choice) => (
            <option key={choice.value} value={choice.value} disabled={choice.disabled}>
              {choice.label}
            </option>
          ))}
      </optgroup>
      <optgroup label="Subscription accounts">
        {accounts
          .filter((account) => account.models.length === 0)
          .map(({ account }) => (
            <option key={account.id} value={`unavailable:${account.id}`} disabled>
              {account.label ?? (account.driver === "claude" ? "Claude Code" : "Codex")} ·
              unavailable
            </option>
          ))}
        {choices
          .filter((choice) => choice.selection.kind === "subscription")
          .map((choice) => (
            <option key={choice.value} value={choice.value} disabled={choice.disabled}>
              {choice.label}
            </option>
          ))}
      </optgroup>
    </select>
  );
}
