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
  expect(screen.getByRole("option", { name: /Work.*unavailable/ })).toBeDisabled();
});

it.each([null, "Work"])(
  "names verified paying identities and stably distinguishes duplicate identities: %s",
  (label) => {
    const first = { ...accounts[0]!, account: { ...accounts[0]!.account, label } };
    const second = {
      ...first,
      account: {
        ...first.account,
        id: "d939aa6e-dc6d-4770-aab6-aa5249cb98ef",
        auth: { ...first.account.auth, email: "grace@example.com" },
      },
    };
    const { rerender } = render(
      <ExecutionPicker
        models={[]}
        fallback={undefined}
        accounts={[first, second]}
        selection={null}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByRole("option", { name: /ada@example.com/ })).toBeEnabled();
    expect(screen.getByRole("option", { name: /grace@example.com/ })).toBeEnabled();
    const duplicate = { ...second, account: { ...second.account, auth: first.account.auth } };
    rerender(
      <ExecutionPicker
        models={[]}
        fallback={undefined}
        accounts={[first, duplicate]}
        selection={null}
        onChange={vi.fn()}
      />,
    );
    const names = screen
      .getAllByRole("option")
      .filter((option) => !option.hasAttribute("disabled"))
      .map((option) => option.textContent);
    expect(new Set(names).size).toBe(2);
    rerender(
      <ExecutionPicker
        models={[]}
        fallback={undefined}
        accounts={[duplicate, first]}
        selection={null}
        onChange={vi.fn()}
      />,
    );
    expect(
      screen
        .getAllByRole("option")
        .filter((option) => !option.hasAttribute("disabled"))
        .map((option) => option.textContent),
    ).toEqual([...names].reverse());
  },
);
