import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ComputerRecoveryNotice } from "./computer-recovery-notice.tsx";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const NOW = 1_000_000;
function setup(replies: Record<string, Response[]>, confirm = vi.fn(() => true)) {
  const calls: { url: string; init?: RequestInit | undefined }[] = [];
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const route = url.split("/").at(-1) ?? "";
    const reply = replies[route]?.shift();
    if (!reply) throw new Error(`No reply scripted for ${route}.`);
    return reply;
  });
  render(<ComputerRecoveryNotice sessionId="session-a" fetch={fetcher} confirm={confirm} />);
  return { calls, fetcher, confirm };
}
const flush = () =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

it("shows nothing while the project's computer is not stuck", async () => {
  const f = setup({ recovery: [json({ stuck: false })] });
  await flush();
  expect(screen.queryByRole("region", { name: "Computer paused" })).toBeNull();
  expect(f.calls[0]?.url).toMatch(/\/sessions\/session-a\/computer\/recovery$/);
  expect(f.calls[0]?.init).toMatchObject({ credentials: "include", cache: "no-store" });
});

it("explains the pause and only offers abandoning once Nap has stopped retrying", async () => {
  setup({ recovery: [json({ stuck: true, abandonableAt: NOW + 120_000 })] });
  await flush();
  const notice = screen.getByRole("region", { name: "Computer paused" });
  expect(notice.textContent).toMatch(/stopped responding/);
  const button = screen.getByRole("button", { name: "Abandon this computer" });
  expect(button).toHaveProperty("disabled", true);
  expect(notice.textContent).toMatch(/still trying to reach it/);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(120_000);
  });
  expect(button).toHaveProperty("disabled", false);
});

it("warns before abandoning and sends nothing when the owner declines", async () => {
  const f = setup(
    { recovery: [json({ stuck: true, abandonableAt: NOW })] },
    vi.fn(() => false),
  );
  await flush();
  await act(async () => {
    screen.getByRole("button", { name: "Abandon this computer" }).click();
  });
  expect(f.confirm).toHaveBeenCalledWith(expect.stringMatching(/last saved version/));
  expect(f.calls.map((call) => call.url.split("/").at(-1))).toEqual(["recovery"]);
});

it("abandons through a private JSON write and says what happens next", async () => {
  const f = setup({
    recovery: [json({ stuck: true, abandonableAt: NOW })],
    abandon: [json({ outcome: "abandoned" })],
  });
  await flush();
  await act(async () => {
    screen.getByRole("button", { name: "Abandon this computer" }).click();
  });
  await flush();
  const post = f.calls.find((call) => call.url.endsWith("/abandon"));
  expect(post?.init).toMatchObject({
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  expect(screen.queryByRole("button", { name: "Abandon this computer" })).toBeNull();
  expect(screen.getByRole("status").textContent).toMatch(/fresh computer from your last saved/);
});

it("reports a machine that came back on the last try, with nothing lost", async () => {
  setup({
    recovery: [json({ stuck: true, abandonableAt: NOW })],
    abandon: [json({ outcome: "recovered" })],
  });
  await flush();
  await act(async () => {
    screen.getByRole("button", { name: "Abandon this computer" }).click();
  });
  await flush();
  expect(screen.getByRole("status").textContent).toMatch(/responded after all/);
});

it("keeps the notice and explains a refusal", async () => {
  setup({
    recovery: [json({ stuck: true, abandonableAt: NOW })],
    abandon: [json({ code: "busy", error: "A turn is running in this project." }, 409)],
  });
  await flush();
  await act(async () => {
    screen.getByRole("button", { name: "Abandon this computer" }).click();
  });
  await flush();
  expect(screen.getByRole("region", { name: "Computer paused" })).toBeDefined();
  expect(screen.getByRole("alert").textContent).toMatch(/turn is running/);
});

it("checks again while the page stays open", async () => {
  const f = setup({
    recovery: [json({ stuck: false }), json({ stuck: true, abandonableAt: NOW })],
  });
  await flush();
  expect(screen.queryByRole("region", { name: "Computer paused" })).toBeNull();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30_000);
  });
  expect(f.calls).toHaveLength(2);
  expect(screen.getByRole("region", { name: "Computer paused" })).toBeDefined();
});
