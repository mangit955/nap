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

it("tells the owner nothing was abandoned when nothing was holding the computer any more", async () => {
  // The reaper drained it between the last check and the click, or another tab got there first.
  setup({
    recovery: [json({ stuck: true, abandonableAt: NOW })],
    abandon: [json({ outcome: "clear" })],
  });
  await flush();
  await act(async () => {
    screen.getByRole("button", { name: "Abandon this computer" }).click();
  });
  await flush();
  const status = screen.getByRole("status").textContent;
  expect(status).toMatch(/nothing was abandoned or lost/);
  expect(status).not.toMatch(/stopped using that computer|fresh computer/);
});

it("ignores a check that was in flight when an abandon finished", async () => {
  let release: (response: Response) => void = () => {};
  let checks = 0;
  const fetcher = vi.fn(async (url: string) => {
    if (url.endsWith("/abandon")) return json({ outcome: "abandoned" });
    checks += 1;
    if (checks === 1) return json({ stuck: true, abandonableAt: NOW });
    return new Promise<Response>((resolve) => {
      release = resolve;
    });
  });
  render(<ComputerRecoveryNotice sessionId="s" fetch={fetcher} confirm={() => true} />);
  await flush();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30_000);
  });
  await act(async () => {
    screen.getByRole("button", { name: "Abandon this computer" }).click();
  });
  await flush();
  // Read before the abandon committed, answered after it.
  await act(async () => release(json({ stuck: true, abandonableAt: NOW })));
  await flush();
  expect(screen.queryByRole("button", { name: "Abandon this computer" })).toBeNull();
  expect(screen.getByRole("status").textContent).toMatch(/fresh computer/);
});

it("retires an earlier outcome and refusal once a later check changes the picture", async () => {
  setup({
    recovery: [
      json({ stuck: true, abandonableAt: NOW }),
      json({ stuck: true, abandonableAt: NOW + 1 }),
      json({ stuck: false }),
    ],
    abandon: [json({ outcome: "recovered" })],
  });
  await flush();
  await act(async () => {
    screen.getByRole("button", { name: "Abandon this computer" }).click();
  });
  await flush();
  expect(screen.getByRole("status").textContent).toMatch(/responded after all/);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30_000); // paused again
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30_000); // and resolved by the reaper
  });
  expect(screen.queryByRole("status")).toBeNull();
  expect(screen.queryByRole("region", { name: "Computer paused" })).toBeNull();
});

it("drops a refusal once the pause it was about has ended", async () => {
  setup({
    recovery: [
      json({ stuck: true, abandonableAt: NOW }),
      json({ stuck: false }),
      json({ stuck: true, abandonableAt: NOW }),
    ],
    abandon: [json({ code: "busy", error: "A turn is running in this project." }, 409)],
  });
  await flush();
  await act(async () => {
    screen.getByRole("button", { name: "Abandon this computer" }).click();
  });
  await flush();
  expect(screen.getByRole("alert").textContent).toMatch(/turn is running/);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30_000); // that pause ended
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30_000); // and a later, unrelated one began
  });
  expect(screen.getByRole("region", { name: "Computer paused" })).toBeDefined();
  expect(screen.queryByRole("alert")).toBeNull();
});

it("checks at once after an abandon whose answer was lost, and says it may have happened", async () => {
  const f = setup({
    recovery: [json({ stuck: true, abandonableAt: NOW }), json({ stuck: false })],
    abandon: [json({ error: "Desktop is unavailable.", code: "desktop_unavailable" }, 503)],
  });
  await flush();
  await act(async () => {
    screen.getByRole("button", { name: "Abandon this computer" }).click();
  });
  await flush();
  expect(f.calls.map((call) => call.url.split("/").at(-1))).toEqual([
    "recovery",
    "abandon",
    "recovery",
  ]);
  expect(screen.getByRole("status").textContent).toMatch(/If Nap abandoned it/);
});

it("says so when an abandon whose answer was lost left the computer paused", async () => {
  setup({
    recovery: [
      json({ stuck: true, abandonableAt: NOW }),
      json({ stuck: true, abandonableAt: NOW }),
    ],
    abandon: [json({ error: "Desktop is unavailable.", code: "desktop_unavailable" }, 503)],
  });
  await flush();
  await act(async () => {
    screen.getByRole("button", { name: "Abandon this computer" }).click();
  });
  await flush();
  expect(screen.getByRole("alert").textContent).toMatch(/still paused/);
  expect(screen.getByRole("button", { name: "Abandon this computer" })).toHaveProperty(
    "disabled",
    false,
  );
});

it("stops asking a deployment that has no such route", async () => {
  const f = setup({ recovery: [json({ error: "not found" }, 404)] });
  await flush();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(90_000);
  });
  expect(f.calls).toHaveLength(1);
});

it("checks again as soon as the owner comes back to the tab", async () => {
  const f = setup({
    recovery: [json({ stuck: false }), json({ stuck: true, abandonableAt: NOW })],
  });
  await flush();
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await flush();
  expect(f.calls).toHaveLength(2);
  expect(screen.getByRole("region", { name: "Computer paused" })).toBeDefined();
});

it("says it is abandoning while the request is in flight, and why the button waits", async () => {
  let answer: (response: Response) => void = () => {};
  const fetcher = vi.fn(async (url: string) =>
    url.endsWith("/abandon")
      ? new Promise<Response>((resolve) => {
          answer = resolve;
        })
      : json({ stuck: true, abandonableAt: NOW + 60_000 }),
  );
  render(<ComputerRecoveryNotice sessionId="s" fetch={fetcher} confirm={() => true} />);
  await flush();
  const waiting = screen.getByRole("button", { name: "Abandon this computer" });
  expect(waiting.getAttribute("aria-describedby")).toBeTruthy();
  expect(
    document.getElementById(waiting.getAttribute("aria-describedby") ?? "")?.textContent,
  ).toMatch(/still trying to reach it/);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60_000);
  });
  expect(waiting.getAttribute("aria-describedby")).toBeNull();
  await act(async () => waiting.click());
  const region = screen.getByRole("region", { name: "Computer paused" });
  expect(region.getAttribute("aria-busy")).toBe("true");
  expect(screen.getByRole("button", { name: "Abandoning…" })).toHaveProperty("disabled", true);
  await act(async () => answer(json({ outcome: "abandoned" })));
  await flush();
  expect(screen.getByRole("status").textContent).toMatch(/fresh computer/);
});
