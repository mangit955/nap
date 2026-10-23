import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BACKOFF } from "../hooks/use-event-stream.ts";
import { ev, PROJECT_ID, SESSION_ID } from "../testing/events.ts";
import { sockets } from "../testing/fake-socket.ts";
import { JOB_ID, jobLog } from "../testing/job-events.ts";
import { mediaBrowser } from "../testing/media-browser.ts";
import { AppShell } from "./app-shell.tsx";

/**
 * Queries go through roles and accessible names, never class names or test ids.
 *
 * That matters more here than usual now that the panes have no visible headings: the workbench
 * says which half is showing with a tab, and the chat's own name exists only for a reader. A
 * region nobody can name is a region a screen reader cannot find, and with the title bars gone
 * these assertions are the only thing keeping those names alive.
 */

/**
 * The shell asks the server which project it is showing, and subscribes to its log. Both come in
 * as arguments, so this file supplies a server that answers and a socket that opens — rather
 * than stubbing the global `fetch` with a promise that never settles, which pinned every
 * assertion here to the first frame.
 */
const fetchJson = async (url: string): Promise<Response> => {
  const body = url.includes("/files")
    ? { files: ["src/App.tsx"], ready: true }
    : {
        projectId: PROJECT_ID,
        // `ready`, not `running`: the record's own vocabulary, and the schema refuses anything
        // else — a record that fails to parse leaves the whole shell in its error state, which
        // is a workspace none of the assertions below meant to be describing.
        name: "Todo app",
        status: "ready",
        sandboxId: "sbx_1",
        updatedAt: "2026-08-09T12:30:00.000Z",
        sessionIds: [SESSION_ID],
      };

  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};

/** The shell under test, wired to a server that answers and a socket that can be pushed to. */
function shell() {
  return (
    <AppShell projectId={PROJECT_ID} fetchJson={fetchJson} createSocket={sockets().createSocket} />
  );
}

describe("AppShell", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it.each(["ordinary-event", "socket-reconnect"])(
    "keeps the existing preview iframe across %s",
    async (scenario) => {
      vi.useFakeTimers();
      const net = sockets();
      const view = render(
        <AppShell projectId={PROJECT_ID} fetchJson={fetchJson} createSocket={net.createSocket} />,
      );
      try {
        await act(async () => {});
        expect(net.opened).toHaveLength(1);
        await act(async () => {
          net.latest.open();
          net.latest.deliver({
            type: "event",
            event: ev("preview.ready", { url: "https://5173-existing.e2b.dev", port: 5173 }, 1),
          });
        });
        expect(screen.queryByTitle("App preview")).toBeNull();
        await act(async () => net.latest.deliver({ type: "ready" }));
        const original = screen.getByTitle("App preview");
        expect(original.isConnected).toBe(true);

        if (scenario === "ordinary-event") {
          await act(async () => {
            net.latest.deliver({
              type: "event",
              event: ev("agent.message", { text: "Still here" }, 2),
            });
          });
        } else {
          act(() => net.latest.drop());
          expect(screen.getByTitle("App preview")).toBe(original);
          await act(async () => {
            await vi.advanceTimersByTimeAsync(BACKOFF.initialMs);
          });
          expect(net.opened).toHaveLength(2);
          expect(net.seqOf(1)).toBe("1");
          expect(new URL(net.latest.url).searchParams.get("repairOwnership")).toBe("1");
          expect(original.isConnected).toBe(true);
          expect(screen.getByTitle("App preview")).toBe(original);
          await act(async () => net.latest.open());
          expect(original.isConnected).toBe(true);
          expect(screen.getByTitle("App preview")).toBe(original);
          await act(async () => net.latest.deliver({ type: "ready" }));
        }
        expect(original.isConnected).toBe(true);
        expect(screen.getByTitle("App preview")).toBe(original);
      } finally {
        view.unmount();
      }
    },
  );

  it("keeps a mobile draft, reference and chosen model while inspecting code", async () => {
    const media = mediaBrowser();
    vi.spyOn(window, "matchMedia").mockImplementation((query) => ({
      matches: query === "(max-width: 980px)",
      media: query,
      onchange: null,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent: () => false,
    }));
    const models = {
      models: [
        { id: "openai/gpt-5.6-luna", label: "Luna", free: false, available: true },
        { id: "anthropic/claude-opus-5", label: "Opus", free: false, available: true },
      ],
      fallback: "openai/gpt-5.6-luna",
      key: { configured: false },
    };
    const net = sockets();
    const view = render(
      <AppShell
        projectId={PROJECT_ID}
        createSocket={net.createSocket}
        fetchJson={(url) =>
          url.endsWith("/models") ? Promise.resolve(Response.json(models)) : fetchJson(url)
        }
      />,
    );
    try {
      await screen.findByRole("button", { name: "Model" });
      fireEvent.change(screen.getByRole("textbox", { name: "Message" }), {
        target: { value: "Keep this draft" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Model" }));
      fireEvent.click(screen.getByRole("button", { name: /Opus/ }));
      fireEvent.change(screen.getByLabelText("Attach images or videos"), {
        target: { files: [new File(["small"], "reference.png", { type: "image/png" })] },
      });
      await screen.findByRole("button", { name: "Remove reference.png" });
      const preview = screen.getByRole("img", { name: "reference.png" }).getAttribute("src");

      fireEvent.click(screen.getByRole("button", { name: "Model" }));
      expect(screen.getByRole("button", { name: /Opus/ })).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Show right panel" }));
      fireEvent.click(screen.getByRole("tab", { name: "Files" }));
      expect(screen.queryByRole("region", { name: "Chat" })).toBeNull();
      expect(screen.queryByRole("textbox", { name: "Message" })).toBeNull();
      expect(screen.queryByRole("button", { name: /Opus/ })).toBeNull();
      expect(media.revokeObjectURL).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "Close right panel" }));

      expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue("Keep this draft");
      expect(screen.getByRole("button", { name: "Model" })).toHaveTextContent("Opus");
      expect(screen.getByRole("img", { name: "reference.png" })).toHaveAttribute(
        "src",
        preview ?? "",
      );
      expect(net.opened).toHaveLength(1);
    } finally {
      view.unmount();
      media.restore();
    }
  });

  it("keeps Stop available after a mobile tab switch before the worker's first event", async () => {
    vi.spyOn(window, "matchMedia").mockImplementation((query) => ({
      matches: true,
      media: query,
      onchange: null,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent: () => false,
    }));
    const net = sockets();
    render(
      <AppShell
        projectId={PROJECT_ID}
        createSocket={net.createSocket}
        fetchJson={(url) =>
          url.endsWith("/turns")
            ? Promise.resolve(
                Response.json(
                  { accepted: true, requestId: "8c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f" },
                  { status: 202 },
                ),
              )
            : fetchJson(url)
        }
      />,
    );
    await waitFor(() => expect(net.opened).toHaveLength(1));
    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), {
      target: { value: "Build this" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await screen.findByRole("button", { name: "Stop" });
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Show right panel" }));
    fireEvent.click(screen.getByRole("tab", { name: "Files" }));
    fireEvent.click(screen.getByRole("button", { name: "Close right panel" }));
    expect(screen.getByRole("button", { name: "Stop" })).toBeEnabled();
    expect(screen.getByRole("textbox", { name: "Message" })).toBeDisabled();
  });

  it("draws no line or card for what happened while the chat was out of view", async () => {
    const net = sockets();
    render(
      <AppShell projectId={PROJECT_ID} createSocket={net.createSocket} fetchJson={fetchJson} />,
    );
    await waitFor(() => expect(net.opened).toHaveLength(1));
    await act(async () => {
      net.latest.open();
      net.latest.deliver({ type: "event", event: ev("user.message", { text: "First" }, 1) });
      net.latest.deliver({ type: "ready" });
    });

    fireEvent.click(screen.getByRole("button", { name: "Hide chat" }));
    await act(async () => {
      net.latest.deliver({
        type: "event",
        event: ev("turn.failed", { reason: "sandbox_unavailable", message: "no capacity" }, 2),
      });
    });
    fireEvent.click(screen.getByRole("button", { name: "Show chat" }));

    expect((await screen.findAllByText("The workspace couldn't start.")).length).toBeGreaterThan(0);
    expect(screen.queryByText(/new since you were last here/i)).toBeNull();
    expect(screen.queryByRole("region", { name: /while you were away/i })).toBeNull();
    expect(localStorage.getItem(`nap.seen.${SESSION_ID}`)).toBeNull();
  });

  it("opens a file the agent mentions in the Code tab", async () => {
    const net = sockets();
    render(
      <AppShell projectId={PROJECT_ID} createSocket={net.createSocket} fetchJson={fetchJson} />,
    );
    await waitFor(() => expect(net.opened).toHaveLength(1));
    await act(async () => {
      net.latest.open();
      net.latest.deliver({
        type: "event",
        event: ev("agent.message", { text: "The list is in `src/App.tsx`." }, 1),
      });
      net.latest.deliver({ type: "ready" });
    });

    fireEvent.click(await screen.findByRole("button", { name: "Open src/App.tsx" }));

    expect(screen.getByRole("tab", { name: "App.tsx" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("region", { name: "src/App.tsx (read-only)" })).toBeInTheDocument();
  });

  it("mounts the chat beside the workbench", () => {
    render(shell());

    expect(screen.getByRole("region", { name: "Chat" })).toBeInTheDocument();
    expect(screen.getByRole("tabpanel", { name: "Browser" })).toBeInTheDocument();
  });

  it("offers both halves of the workbench, with the preview showing first", () => {
    // The preview is what somebody came to watch; the code is what they go looking for.
    render(shell());

    expect(screen.getByRole("tab", { name: "Browser" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Files" })).toHaveAttribute("aria-selected", "false");
  });

  it("shows the code when its tab is pressed", () => {
    render(shell());

    fireEvent.click(screen.getByRole("tab", { name: "Files" }));

    expect(screen.getByRole("tab", { name: "Files" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("region", { name: "Files" })).toBeVisible();
  });

  it("gives the whole window to the workbench when the chat is hidden", () => {
    render(shell());

    fireEvent.click(screen.getByRole("button", { name: /hide chat/i }));

    expect(screen.queryByRole("region", { name: "Chat" })).toBeNull();
    expect(screen.getByRole("button", { name: /show chat/i })).toBeInTheDocument();
  });

  it("keeps where the job stands on screen once the chat is hidden", async () => {
    // Anything inside the chat pane goes with it, so the job's phase lives in the bar: otherwise
    // collapsing the chat would take the one signal saying whether the project works off the
    // screen — precisely when the preview is most dominant.
    const net = sockets();
    const log = jobLog();
    render(
      <AppShell projectId={PROJECT_ID} fetchJson={fetchJson} createSocket={net.createSocket} />,
    );

    await waitFor(() => expect(net.opened).toHaveLength(1));
    await act(async () => {
      net.latest.open();
      net.latest.deliver({ type: "event", event: log.opened() });
      net.latest.deliver({
        type: "event",
        event: log.at("verification.started", { jobId: JOB_ID }),
      });
      net.latest.deliver({ type: "ready" });
    });

    const bar = () => screen.getByRole("status", { name: /job phase/i });
    expect(bar()).toHaveTextContent(/verifying/i);

    fireEvent.click(screen.getByRole("button", { name: /hide chat/i }));

    expect(screen.queryByRole("region", { name: "Chat" })).toBeNull();
    expect(bar()).toHaveTextContent(/verifying/i);
  });

  it("lets the divider be moved without a mouse", () => {
    // A drag handle that only answers a pointer is unreachable for anybody who does not use
    // one, and this one decides how much of the screen the transcript gets.
    render(shell());

    const divider = screen.getByRole("separator", { name: /right panel width/i });
    const before = Number(divider.getAttribute("aria-valuenow"));

    fireEvent.keyDown(divider, { key: "ArrowRight" });

    expect(Number(divider.getAttribute("aria-valuenow"))).toBeLessThan(before);
  });

  it("renders exactly one main landmark", () => {
    render(shell());

    expect(screen.getAllByRole("main")).toHaveLength(1);
  });

  it("clips at the frame, so no pane can scroll the whole page", () => {
    /*
     * Reached by class, which this file otherwise never does, and it is worth saying why rather
     * than quietly making an exception. The workspace is a fixed-height frame: only the iframe,
     * the file viewer, the tree and the transcript may scroll. Nothing clipped between `main` and
     * the document, and `html, body` are `height: 100%` with overflow visible — so one leaking
     * row in the transcript scrolled the entire page, top bar and all, out of the window.
     *
     * jsdom lays nothing out. `scrollHeight` is 0 for every element here, so the declaration is
     * the only observable and this test cannot prove the page does not scroll — only that the
     * clamp has not been dropped by a refactor. The measurement that proves it needs a browser:
     * `documentElement.scrollHeight === documentElement.clientHeight`.
     */
    const { container } = render(shell());

    expect(screen.getByRole("main")).toHaveClass("overflow-hidden");
    expect(container.firstElementChild).toHaveClass("overflow-hidden");
  });

  it("keeps the workbench controls in the workspace banner", () => {
    render(shell());
    expect(screen.getByRole("banner")).not.toContainElement(
      screen.getByRole("tablist", { name: "Workbench" }),
    );
    expect(screen.getByRole("tablist", { name: "Workbench" })).toBeInTheDocument();
  });
});
