import type { SubscriptionCatalog } from "@nap/shared/subscription-protocol";
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { ExecutionPicker } from "./execution-picker.tsx";

const accountId = "d939aa6e-dc6d-4770-aab6-aa5249cb98ee";
const accounts: SubscriptionCatalog["accounts"] = [
  {
    account: {
      id: accountId,
      driver: "claude",
      label: "Work",
      enabled: true,
      auth: { status: "authenticated", email: "ada@example.com", plan: null },
      createdAt: "2026-10-24T00:00:00.000Z",
    },
    availability: "ready",
    models: [{ id: "same-model", label: "Claude", supportsImages: false }],
  },
];
const models = [{ id: "same-model", label: "Claude", free: false, available: true }];

it("distinguishes subscription accounts from API models with the same model ID", () => {
  const onChange = vi.fn();
  render(
    <ExecutionPicker
      models={models}
      fallback="same-model"
      accounts={accounts}
      selection={null}
      onChange={onChange}
    />,
  );
  const select = screen.getByRole("combobox", { name: "Account and model" });
  const option = screen.getByRole("option", { name: /Work.*Claude.*text only/i });
  fireEvent.change(select, { target: { value: option.getAttribute("value") } });
  expect(onChange).toHaveBeenCalledWith({ kind: "subscription", accountId, model: "same-model" });
});

it("keeps a deleted account selected until the user explicitly chooses another route", () => {
  render(
    <ExecutionPicker
      models={models}
      fallback="same-model"
      accounts={[]}
      selection={{ kind: "subscription", accountId, model: "same-model" }}
      onChange={vi.fn()}
    />,
  );
  expect(screen.getByRole("combobox")).toHaveDisplayValue("Selected subscription unavailable");
  expect(screen.getByRole("option", { name: "Selected subscription unavailable" })).toBeDisabled();
});

it("shows configured accounts without pretending they have a runnable model", () => {
  render(
    <ExecutionPicker
      models={models}
      fallback="same-model"
      accounts={[{ ...accounts[0]!, models: [], availability: "unavailable" }]}
      selection={null}
      onChange={vi.fn()}
    />,
  );
  expect(screen.getByRole("option", { name: "Work · unavailable" })).toBeDisabled();
});
