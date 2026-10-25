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
  onAddKey,
}: {
  models: readonly ModelChoice[];
  fallback: string | undefined;
  accounts: SubscriptionCatalog["accounts"];
  selection: ExecutionSelection | null;
  disabled?: boolean;
  onChange: (selection: ExecutionSelection) => void;
  onAddKey?: (() => void) | undefined;
}) {
  const identity = (account: SubscriptionCatalog["accounts"][number]["account"]) =>
    [
      account.label ?? (account.driver === "claude" ? "Claude Code" : "Codex"),
      account.auth.status === "authenticated" ? account.auth.email : null,
    ]
      .filter(Boolean)
      .join(" · ");
  const accountName = (account: SubscriptionCatalog["accounts"][number]["account"]) => {
    const name = identity(account);
    const verified = account.auth.status === "authenticated" && account.auth.email !== null;
    const duplicate = accounts.some(
      (entry) => entry.account.id !== account.id && identity(entry.account) === name,
    );
    return !verified || duplicate ? `${name} · ${account.id}` : name;
  };
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
        label: `${accountName(account)} · ${model.label}${model.supportsImages ? "" : " · Text only"}${availability === "ready" ? "" : ` · ${availability.replaceAll("_", " ")}`}`,
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
    <div className="flex min-w-0 items-center gap-1">
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
                {accountName(account)} · unavailable
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
      {onAddKey !== undefined && models.some((model) => !model.available) && (
        <button
          type="button"
          onClick={onAddKey}
          className="shrink-0 rounded-lg px-2 text-xs text-ink-2 underline focus-visible:outline-accent"
        >
          Add API key
        </button>
      )}
    </div>
  );
}
