/**
 * What the live pane tells the shell about the preview it is looking at.
 *
 * The report is the only route by which anything above this pane learns that a restore came up
 * — the pane holds the socket, and a second subscription upstairs would be a second connection
 * asking the same question. **The `seq` is the load-bearing half**: a project put away and
 * started again has two `preview.ready` events in its log, and an address alone cannot say
 * which one is the live sandbox.
 *
 * `useEventStream` is mocked because nothing in the `web` project can open a WebSocket; what is
 * left is exactly the wiring.
 */

import type { NapEvent, NapEventType } from "@nap/shared/events";
import type { StoredEvent } from "@nap/shared/ports/event-store";
import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const events: StoredEvent[] = [];

vi.mock("../hooks/use-event-stream.ts", () => ({
  useEventStream: () => ({ events, status: "open" }),
}));

const { LivePreviewPane } = await import("./preview-pane.tsx");

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

beforeEach(() => {
  events.length = 0;
});

describe("what the live pane reports upward", () => {
  it("names the announcement, not just the address", () => {
    events.push(ev("preview.ready", { url: "https://5173-sbx.e2b.app", port: 5173 }, 7));
    const report = vi.fn();

    render(<LivePreviewPane sessionId={SESSION} onPreviewReady={report} />);

    expect(report).toHaveBeenCalledWith({ url: "https://5173-sbx.e2b.app", seq: 7 });
  });

  it("reports the newest announcement when a project has been restarted", () => {
    // Both are in the log: the sandbox that was closed, and the one that replaced it. Reporting
    // the older one would tell the shell a restore had come up while pointing at a dead address.
    events.push(
      ev("preview.ready", { url: "https://5173-old.e2b.app", port: 5173 }, 7),
      ev("preview.stopped", {}, 8),
      ev("preview.ready", { url: "https://5173-new.e2b.app", port: 5173 }, 9),
    );
    const report = vi.fn();

    render(<LivePreviewPane sessionId={SESSION} onPreviewReady={report} />);

    expect(report).toHaveBeenLastCalledWith({ url: "https://5173-new.e2b.app", seq: 9 });
  });

  it("reports nothing once the preview has stopped", () => {
    events.push(
      ev("preview.ready", { url: "https://5173-sbx.e2b.app", port: 5173 }, 7),
      ev("preview.stopped", {}, 8),
    );
    const report = vi.fn();

    render(<LivePreviewPane sessionId={SESSION} onPreviewReady={report} />);

    expect(report).toHaveBeenCalledWith(undefined);
  });
});
