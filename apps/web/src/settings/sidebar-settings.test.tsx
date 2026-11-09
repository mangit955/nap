import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { SidebarSettings } from "./sidebar-settings.tsx";

function server(initial = { afterDays: null as number | null, onMerge: false }) {
  let stored = initial;
  const writes: unknown[] = [];
  const fetchJson = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === "PUT") {
      stored = JSON.parse(String(init.body));
      writes.push(stored);
    }
    return new Response(JSON.stringify(stored), { status: 200 });
  });
  return { fetchJson, writes };
}

it("is off until turned on, then saves each rule as it changes", async () => {
  const { fetchJson, writes } = server();
  render(<SidebarSettings fetchJson={fetchJson} baseUrl="https://api.example" />);
  const after = await screen.findByRole("checkbox", { name: "Settle sessions with no activity" });
  const merge = screen.getByRole("checkbox", { name: /pull request merges/ });
  expect(after).not.toBeChecked();
  expect(merge).not.toBeChecked();
  expect(screen.getByRole("spinbutton", { name: "Days without activity" })).toBeDisabled();

  fireEvent.click(after);
  await waitFor(() => expect(writes).toEqual([{ afterDays: 7, onMerge: false }]));
  const days = screen.getByRole("spinbutton", { name: "Days without activity" });
  await waitFor(() => expect(days).toBeEnabled());
  fireEvent.change(days, { target: { value: "14" } });
  fireEvent.blur(days);
  await waitFor(() => expect(writes.at(-1)).toEqual({ afterDays: 14, onMerge: false }));

  fireEvent.click(merge);
  await waitFor(() => expect(writes.at(-1)).toEqual({ afterDays: 14, onMerge: true }));
  expect(fetchJson).toHaveBeenCalledWith("https://api.example/sessions/auto-settle", undefined);
});

it("refuses a day count the server would refuse, and sends nothing", async () => {
  const { fetchJson, writes } = server({ afterDays: 7, onMerge: false });
  render(<SidebarSettings fetchJson={fetchJson} baseUrl="https://api.example" />);
  const days = await screen.findByRole("spinbutton", { name: "Days without activity" });
  await waitFor(() => expect(days).toBeEnabled());
  fireEvent.change(days, { target: { value: "0" } });
  fireEvent.blur(days);
  expect(screen.getByRole("alert")).toHaveTextContent("Choose between 1 and 365 days.");
  expect(days).toHaveValue(7);
  expect(writes).toEqual([]);
});

it("saves the days on Enter, and drops a refusal once a good count is typed", async () => {
  const { fetchJson, writes } = server({ afterDays: 7, onMerge: false });
  render(<SidebarSettings fetchJson={fetchJson} baseUrl="https://api.example" />);
  const days = await screen.findByRole("spinbutton", { name: "Days without activity" });
  fireEvent.change(days, { target: { value: "0" } });
  fireEvent.blur(days);
  expect(screen.getByRole("alert")).toBeInTheDocument();
  // Back to what is saved: nothing to send, and nothing wrong any more.
  fireEvent.change(days, { target: { value: "7" } });
  fireEvent.keyDown(days, { key: "Enter" });
  expect(screen.queryByRole("alert")).toBeNull();
  fireEvent.change(days, { target: { value: "21" } });
  fireEvent.keyDown(days, { key: "Enter" });
  await waitFor(() => expect(writes).toEqual([{ afterDays: 21, onMerge: false }]));
});

it("keeps both a typed day count and the checkbox click that took focus from it", async () => {
  const { fetchJson, writes } = server({ afterDays: 7, onMerge: false });
  render(<SidebarSettings fetchJson={fetchJson} baseUrl="https://api.example" />);
  const days = await screen.findByRole("spinbutton", { name: "Days without activity" });
  const merge = screen.getByRole("checkbox", { name: /pull request merges/ });
  fireEvent.change(days, { target: { value: "14" } });
  // Pressing the checkbox blurs the field first, which starts a save of its own.
  fireEvent.blur(days);
  fireEvent.click(merge);
  await waitFor(() => expect(writes.at(-1)).toEqual({ afterDays: 14, onMerge: true }));
  expect(writes).toEqual([
    { afterDays: 14, onMerge: false },
    { afterDays: 14, onMerge: true },
  ]);
  await waitFor(() => expect(merge).toBeChecked());
});
