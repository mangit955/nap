/**
 * Pressing Resume and getting the app back, without reloading the page.
 *
 * This is the one assertion that describes the bug it was written for: the pane sat on
 * "Starting the dev server…" forever, because the flag that says a restore is under way was set
 * on the request and cleared by nothing. A page reload fixed it only because reloading threw the
 * flag away — the announcement had been in the log the whole time.
 *
 * It goes through `AppShell` rather than through either half alone on purpose. Both halves were
 * individually correct: the hook did not know about events, the pane did not know about the
 * request, and the fault lived exactly in the gap between them.
 *
 * Nothing is mocked. The shell takes its socket factory and its `fetchJson` as arguments, so the
 * real subscription runs against a fake socket — which means this test also holds the rule that
 * a workspace opens *one* connection, since the socket is a countable thing here.
 */

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ev, PROJECT_ID, SESSION_ID } from "../testing/events.ts";
import { sockets } from "../testing/fake-socket.ts";
import { AppShell } from "./app-shell.tsx";
import { PREVIEW_TITLE } from "./preview-pane.tsx";

/** Every open request the page made, so "exactly once" is a countable thing. */
let opens: number;
/** What the server says to an open request. A 202 unless a test wants a refusal. */
let openWith: () => Response;
let net: ReturnType<typeof sockets>;

/** A project the server says is put away, and whatever `openWith` answers to an open. */
const fetchJson = async (url: string, init?: RequestInit): Promise<Response> => {
  if (init?.method === "POST" && url.endsWith("/open")) {
    opens += 1;
    return openWith();
  }

  if (url.includes("/files")) {
    return new Response(JSON.stringify({ files: [], ready: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  return new Response(
    JSON.stringify({
      projectId: PROJECT_ID,
      name: "Todo app",
      status: "idle",
      sandboxId: null,
      updatedAt: "2026-08-09T12:30:00.000Z",
      sessionIds: [SESSION_ID],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
};

function open() {
  return render(
    <AppShell projectId={PROJECT_ID} fetchJson={fetchJson} createSocket={net.createSocket} />,
  );
}

/**
 * The log of a project that ran, then was put away — which is what makes this the hard case:
 * there is already a `preview.ready` in it, belonging to a sandbox that no longer exists.
 */
async function replayPutAway() {
  await act(async () => {
    net.latest.open();
    net.latest.deliver({
      type: "event",
      event: ev("preview.ready", { url: "https://5173-old.e2b.app", port: 5173 }, 7),
    });
    net.latest.deliver({ type: "event", event: ev("preview.stopped", {}, 8) });
    net.latest.deliver({ type: "ready" });
  });
}

beforeEach(() => {
  opens = 0;
  net = sockets();
  net.countGlobalToo(vi.stubGlobal);
  openWith = () =>
    new Response(JSON.stringify({ opened: true }), {
      status: 202,
      headers: { "content-type": "application/json" },
    });
});

describe("opening a put-away project", () => {
  it("starts it without anybody pressing anything", async () => {
    // Nobody navigates to their own app to be asked whether they meant it.
    open();

    await waitFor(() => expect(opens).toBe(1));
    await replayPutAway();

    expect(screen.getByText(/starting the dev server/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^resume$/i })).not.toBeInTheDocument();
  });

  it("subscribes once for the whole workspace", async () => {
    // Three panes used to call the subscription hook for themselves, which was three connections
    // carrying identical frames — and two panes free to sit at different sequence numbers in the
    // same frame, one offering the address of a sandbox the other had watched stop.
    open();
    await waitFor(() => expect(opens).toBe(1));

    expect(net.opened).toHaveLength(1);
  });

  it("never flashes the put-away screen on the way in", async () => {
    // Effects run *after* paint, so a flag set by the auto-start effect is false for the frame
    // the panes first draw in — and in that frame the log already says `preview.stopped`, so
    // the pane drew the whole "This project is put away" screen and its button. An offer to do
    // something that was already happening, for one frame, every single time.
    open();

    // The first paint, before anything has settled.
    expect(screen.queryByRole("button", { name: /^resume$/i })).not.toBeInTheDocument();

    // And every frame after it, up to the request going out.
    await waitFor(() => expect(opens).toBe(1));
    await replayPutAway();
    expect(screen.queryByRole("button", { name: /^resume$/i })).not.toBeInTheDocument();
    expect(screen.getByText(/starting the dev server/i)).toBeInTheDocument();
  });

  it("shows the app as soon as the restore announces itself, with no reload", async () => {
    open();
    await waitFor(() => expect(opens).toBe(1));
    await replayPutAway();

    await act(async () => {
      net.latest.deliver({
        type: "event",
        event: ev("preview.ready", { url: "https://5173-new.e2b.app", port: 5173 }, 9),
      });
    });

    await waitFor(() => expect(screen.getByTitle(PREVIEW_TITLE)).toBeInTheDocument());
    expect(screen.getByTitle(PREVIEW_TITLE)).toHaveAttribute(
      "src",
      expect.stringContaining("5173-new"),
    );
  });

  it("asks once, and only once, when the server refuses", async () => {
    // A refusal deliberately leaves the record still saying the project is put away — the
    // project *is* put away, the request was turned down — so nothing about the page's own
    // state would stop a second attempt, and a page that retries a quota refusal on every
    // render is a page hammering an endpoint that has already said no.
    //
    // Rendered under `StrictMode` because that is how Next runs this in development: it mounts,
    // unmounts and remounts to shake out effects that are not safe to run twice.
    openWith = () =>
      new Response(JSON.stringify({ error: "You already have 2 projects running." }), {
        status: 409,
        headers: { "content-type": "application/json" },
      });

    render(
      <StrictMode>
        <AppShell projectId={PROJECT_ID} fetchJson={fetchJson} createSocket={net.createSocket} />
      </StrictMode>,
    );

    await waitFor(() => expect(net.opened.length).toBeGreaterThan(0));
    await replayPutAway();

    // The refusal, its reason, and the button that is now the way through.
    expect(await screen.findByRole("alert")).toHaveTextContent(/2 projects running/);
    expect(screen.getByRole("button", { name: /^resume$/i })).toBeInTheDocument();
    expect(opens).toBe(1);
  });

  it("starts the next project too, rather than latching after the first", async () => {
    // The guard is keyed to *which* project was started, not to "have I ever started one". A
    // plain boolean would mean the second project you opened in a session never came up — and
    // that failure looks exactly like a server that ignored the request.
    const { rerender } = open();
    await waitFor(() => expect(opens).toBe(1));

    rerender(
      <AppShell
        projectId="9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d"
        fetchJson={fetchJson}
        createSocket={net.createSocket}
      />,
    );

    await waitFor(() => expect(opens).toBe(2));
  });

  it("still starts it by hand after a refusal", async () => {
    openWith = () =>
      new Response(JSON.stringify({ error: "You already have 2 projects running." }), {
        status: 409,
        headers: { "content-type": "application/json" },
      });

    open();
    await waitFor(() => expect(net.opened.length).toBeGreaterThan(0));
    await replayPutAway();

    const resume = await screen.findByRole("button", { name: /^resume$/i });

    await act(async () => {
      fireEvent.click(resume);
    });

    expect(opens).toBe(2);
  });
});
