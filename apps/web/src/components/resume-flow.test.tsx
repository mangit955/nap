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
 * request, and the fault lived exactly in the gap between them. The other tests here mock the
 * pane's props; this one mocks only the two things a jsdom test genuinely cannot do — open a
 * socket, and reach the network.
 */

import type { NapEvent, NapEventType } from "@nap/shared/events";
import type { StoredEvent } from "@nap/shared/ports/event-store";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A stand-in socket the test can push to.
 *
 * It has to be a real subscription rather than a mutable array: an event arriving is the whole
 * subject here, and a hook that returns a module-level array re-renders nobody when it changes
 * — the test would pass or fail on React's scheduling rather than on the component.
 *
 * Built inside the factory because `vi.mock` is hoisted above every import in this file, so
 * anything it closed over from module scope would be in its temporal dead zone.
 */
vi.mock("../hooks/use-event-stream.ts", async () => {
  const { useSyncExternalStore } = await import("react");

  // One object, replaced on every push: `useSyncExternalStore` compares snapshots by identity
  // and loops forever on a getter that builds a new one each call.
  let snapshot: { events: readonly StoredEvent[]; status: string } = { events: [], status: "open" };
  const listeners = new Set<() => void>();

  return {
    useEventStream: () =>
      useSyncExternalStore(
        (onChange: () => void) => {
          listeners.add(onChange);
          return () => listeners.delete(onChange);
        },
        () => snapshot,
      ),
    /** The test's end of the socket. */
    __push: (...arriving: StoredEvent[]) => {
      snapshot = { ...snapshot, events: [...snapshot.events, ...arriving] };
      for (const listener of listeners) listener();
    },
    __reset: () => {
      snapshot = { events: [], status: "open" };
    },
  };
});

const stream = (await import("../hooks/use-event-stream.ts")) as unknown as {
  __push: (...events: StoredEvent[]) => void;
  __reset: () => void;
};

const { AppShell } = await import("./app-shell.tsx");
const { PREVIEW_TITLE } = await import("./preview-pane.tsx");

const PROJECT = "3e0fbc41-6f5d-4a8e-ab9c-4d5e6f708192";
const SESSION = "0b7f8f1e-3c2a-4d5b-9e6f-1a2b3c4d5e6f";
const TURN = "7c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f";

function ev<T extends NapEventType>(
  type: T,
  payload: Extract<NapEvent, { type: T }>["payload"],
  seq: number,
) {
  return {
    type,
    sessionId: SESSION,
    turnId: TURN,
    seq,
    createdAt: "2026-08-09T12:00:00.000Z",
    payload,
  } as StoredEvent;
}

/** Every open request the page made, so "exactly once" is a countable thing. */
let opens: number;
/** What the server says to an open request. A 202 unless a test wants a refusal. */
let openWith: () => Response;

/** A project the server says is put away, and whatever `openWith` answers to an open. */
function serve() {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "POST" && url.endsWith("/open")) {
      opens += 1;
      return openWith();
    }

    return new Response(
      JSON.stringify({
        projectId: PROJECT,
        name: "Todo app",
        status: "idle",
        sandboxId: null,
        updatedAt: "2026-08-09T12:30:00.000Z",
        sessionIds: [SESSION],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
}

beforeEach(() => {
  // The log of a project that ran, then was put away — which is what makes this the hard case:
  // there is already a `preview.ready` in it, belonging to a sandbox that no longer exists.
  stream.__reset();
  stream.__push(
    ev("preview.ready", { url: "https://5173-old.e2b.app", port: 5173 }, 7),
    ev("preview.stopped", {}, 8),
  );
  opens = 0;
  openWith = () =>
    new Response(JSON.stringify({ opened: true }), {
      status: 202,
      headers: { "content-type": "application/json" },
    });
  serve();
});

describe("opening a put-away project", () => {
  it("starts it without anybody pressing anything", async () => {
    // Nobody navigates to their own app to be asked whether they meant it.
    render(<AppShell projectId={PROJECT} />);

    await waitFor(() => expect(opens).toBe(1));
    expect(screen.getByText(/starting the dev server/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^resume$/i })).not.toBeInTheDocument();
  });

  it("shows the app as soon as the restore announces itself, with no reload", async () => {
    render(<AppShell projectId={PROJECT} />);
    await waitFor(() => expect(opens).toBe(1));

    await act(async () => {
      stream.__push(ev("preview.ready", { url: "https://5173-new.e2b.app", port: 5173 }, 9));
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
        <AppShell projectId={PROJECT} />
      </StrictMode>,
    );

    // The refusal, its reason, and the button that is now the way through.
    expect(await screen.findByRole("alert")).toHaveTextContent(/2 projects running/);
    expect(screen.getByRole("button", { name: /^resume$/i })).toBeInTheDocument();
    expect(opens).toBe(1);
  });

  it("starts the next project too, rather than latching after the first", async () => {
    // The guard is keyed to *which* project was started, not to "have I ever started one". A
    // plain boolean would mean the second project you opened in a session never came up — and
    // that failure looks exactly like a server that ignored the request.
    const { rerender } = render(<AppShell projectId={PROJECT} />);
    await waitFor(() => expect(opens).toBe(1));

    rerender(<AppShell projectId="9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d" />);

    await waitFor(() => expect(opens).toBe(2));
  });

  it("still starts it by hand after a refusal", async () => {
    openWith = () =>
      new Response(JSON.stringify({ error: "You already have 2 projects running." }), {
        status: 409,
        headers: { "content-type": "application/json" },
      });

    render(<AppShell projectId={PROJECT} />);
    const resume = await screen.findByRole("button", { name: /^resume$/i });

    await act(async () => {
      fireEvent.click(resume);
    });

    expect(opens).toBe(2);
  });
});
