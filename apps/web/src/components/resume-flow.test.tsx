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

/** A project the server says is put away, and an open request it accepts with a 202. */
function serve() {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "POST" && url.endsWith("/open")) {
      return new Response(JSON.stringify({ opened: true }), {
        status: 202,
        headers: { "content-type": "application/json" },
      });
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
  serve();
});

describe("resuming a put-away project", () => {
  it("shows the app as soon as the restore announces itself, with no reload", async () => {
    render(<AppShell projectId={PROJECT} />);

    const resume = await screen.findByRole("button", { name: /^resume$/i });
    await act(async () => {
      fireEvent.click(resume);
    });

    // The restore is running: the server took the request and nothing has come up yet.
    expect(screen.getByText(/starting the dev server/i)).toBeInTheDocument();

    await act(async () => {
      stream.__push(ev("preview.ready", { url: "https://5173-new.e2b.app", port: 5173 }, 9));
    });

    await waitFor(() => expect(screen.getByTitle(PREVIEW_TITLE)).toBeInTheDocument());
    expect(screen.getByTitle(PREVIEW_TITLE)).toHaveAttribute(
      "src",
      expect.stringContaining("5173-new"),
    );
  });
});
