/**
 * What opening a project costs the browser, as a number that cannot quietly grow with the log.
 *
 * The stream sends one frame per stored event, and every commit of the workspace re-runs each
 * derivation of the whole log — the transcript fold, the preview, the jobs, the changed paths, the
 * tests. One commit per frame made opening a session of N events N² work and one file listing per
 * write it had ever made. Nothing about that is visible in a test that checks what ends up on
 * screen, because the screen ends up right either way; it is visible only as a count.
 *
 * So the whole shell is mounted under a `Profiler` and the same open is done at two sizes: a
 * replay must add no commits while it arrives, and the open as a whole must stay under one small
 * bound, with one listing, at 200 events as at 20. A bound rather than equality: whether the
 * listing's answer lands in the same commit as the replay's effects is a matter of timing, and a
 * count that is 3 or 4 is the same thing — what the guard is against is a count of 200.
 */

import type { StoredEvent } from "@nap/shared/ports/event-store";
import { act, render, screen, waitFor } from "@testing-library/react";
import { Profiler } from "react";
import { beforeEach, expect, it } from "vitest";
import { ev, PROJECT_ID, SESSION_ID } from "../testing/events.ts";
import { sockets } from "../testing/fake-socket.ts";
import { AppShell } from "./app-shell.tsx";

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

/** A finished turn that wrote `writes` files: the shape of a long session's log. */
function session(writes: number): StoredEvent[] {
  const events: StoredEvent[] = [
    ev("user.message", { text: "Build a habit tracker" }, 1),
    ev("turn.started", { source: "user" }, 2),
  ];
  for (let i = 0; i < writes; i++) {
    events.push(
      ev(
        "file.changed",
        { path: `src/file-${i}.ts`, changeType: "created", diff: "+x\n" },
        events.length + 1,
      ),
    );
  }
  events.push(ev("agent.message", { text: "Your habit tracker is ready." }, events.length + 1));
  events.push(
    ev(
      "turn.completed",
      { usage: { inputTokens: 1, outputTokens: 1 }, durationMs: 10, commitSha: null },
      events.length + 1,
    ),
  );
  return events;
}

async function open(writes: number) {
  const net = sockets();
  const listings: string[] = [];
  const fetchJson = async (url: string): Promise<Response> => {
    if (url.includes("/files")) {
      listings.push(url);
      return json({ ready: true, files: ["src/App.tsx"], truncated: false });
    }
    if (url.endsWith("/models")) return json({ models: [], key: { configured: false } });
    if (url.endsWith(`/projects/${PROJECT_ID}`))
      return json({
        projectId: PROJECT_ID,
        name: "Habit tracker",
        status: "ready",
        sandboxId: "sbx_1",
        updatedAt: "2026-08-09T12:30:00.000Z",
        sessionIds: [SESSION_ID],
      });
    return json({});
  };
  let commits = 0;
  const view = render(
    <Profiler
      id="workspace"
      onRender={() => {
        commits += 1;
      }}
    >
      <AppShell projectId={PROJECT_ID} fetchJson={fetchJson} createSocket={net.createSocket} />
    </Profiler>,
  );
  await screen.findByRole("button", { name: /Rename this project.*Habit tracker/ });
  await waitFor(() => expect(net.opened).toHaveLength(1));
  await act(async () => net.latest.open());
  await quiet();

  const before = commits;
  // One `act` per frame, as a browser dispatches one task per message.
  for (const event of session(writes)) act(() => net.latest.deliver({ type: "event", event }));
  const duringReplay = commits - before;

  await act(async () => net.latest.deliver({ type: "ready" }));
  expect(await screen.findByText("Your habit tracker is ready.")).toBeVisible();
  await waitFor(() => expect(listings).toHaveLength(1));
  await quiet();
  view.unmount();

  return { duringReplay, total: commits - before, listings: listings.length };
}

/** Lets every timer and answer the open started run out. */
async function quiet() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

/** Commits an open may cost once the log is in, whatever its length. Today it is 3 or 4. */
const COMMIT_BOUND = 6;

// A frame per `act` is slow in jsdom, so this gets more than the default five seconds; under a
// loaded run of the whole suite it has taken ten.
it("costs a bounded number of commits and one listing to open, at 200 events as at 20", {
  timeout: 30_000,
}, async () => {
  for (const writes of [20, 200]) {
    const { duringReplay, total, listings } = await open(writes);

    expect(duringReplay).toBe(0);
    expect(total).toBeLessThanOrEqual(COMMIT_BOUND);
    expect(listings).toBe(1);
  }
});
