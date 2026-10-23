import type { StoredEvent } from "@nap/shared/ports/event-store";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jobView } from "../chat/job-summary.ts";
import type { SessionLog } from "../hooks/use-session-log.ts";
import { previewState } from "../preview/preview-state.ts";
import { FilePanel } from "./file-panel.tsx";

// Clipboard behavior does not depend on the asynchronous syntax renderer.
vi.mock("next/dynamic", () => ({
  default:
    () =>
    ({ contents }: { contents: string }) => <pre>{contents}</pre>,
}));
const sessionId = "0b7f8f1e-3c2a-4d5b-9e6f-1a2b3c4d5e6f";
const log: SessionLog = {
  events: [],
  status: "open",
  lastSeq: 0,
  replayed: true,
  preview: previewState([]),
  changed: new Set(),
  jobs: jobView([]),
};
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
afterEach(() => {
  if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
  else Reflect.deleteProperty(navigator, "clipboard");
});
function clipboard(value: unknown) {
  Object.defineProperty(navigator, "clipboard", { configurable: true, value });
}
function response(contents = "original") {
  return Response.json({ path: "app.ts", contents, bytes: contents.length, truncated: false });
}
const changed: StoredEvent = {
  type: "file.changed",
  sessionId,
  turnId: "7c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f",
  seq: 1,
  createdAt: "2026-10-23T00:00:00.000Z",
  payload: { path: "/home/user/app/app.ts", changeType: "modified", diff: "" },
};

describe("file clipboard", () => {
  it.each(["unavailable", "throws", "rejects"])(
    "shows the manual fallback when clipboard %s",
    async (mode) => {
      clipboard(
        mode === "unavailable"
          ? undefined
          : {
              writeText: () => {
                if (mode === "throws") throw new Error("blocked");
                return Promise.reject(new Error("blocked"));
              },
            },
      );
      render(
        <FilePanel
          sessionId={sessionId}
          path="app.ts"
          log={log}
          fetchJson={async () => response()}
        />,
      );
      await screen.findByText("original");
      fireEvent.click(screen.getByRole("button", { name: "Copy file" }));
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "Select its contents to copy manually",
      );
    },
  );
  it.each([false, true])(
    "resets copy status after new contents, including a pending copy: %s",
    async (pending) => {
      let resolve = () => {};
      const writeText = vi.fn(() =>
        pending
          ? new Promise<void>((done) => {
              resolve = done;
            })
          : Promise.resolve(),
      );
      clipboard({ writeText });
      const fetchJson = vi.fn(async () => response());
      const { rerender } = render(
        <FilePanel sessionId={sessionId} path="app.ts" log={log} fetchJson={fetchJson} />,
      );
      await screen.findByText("original");
      fireEvent.click(screen.getByRole("button", { name: "Copy file" }));
      expect(writeText).toHaveBeenCalledWith("original");
      if (!pending) await screen.findByRole("button", { name: "Copied file" });
      fetchJson.mockImplementationOnce(async () => response("updated"));
      rerender(
        <FilePanel
          sessionId={sessionId}
          path="app.ts"
          log={{ ...log, events: [changed] }}
          fetchJson={fetchJson}
        />,
      );
      await screen.findByText("updated");
      await act(async () => resolve());
      await waitFor(() => expect(screen.getByRole("button", { name: "Copy file" })).toBeEnabled());
      expect(screen.queryByRole("button", { name: "Copied file" })).not.toBeInTheDocument();
    },
  );
});
