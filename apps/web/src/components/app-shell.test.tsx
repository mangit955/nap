import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PROJECT_ID, SESSION_ID } from "../testing/events.ts";
import { sockets } from "../testing/fake-socket.ts";
import { JOB_ID, jobLog } from "../testing/job-events.ts";
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
  it("mounts the chat beside the workbench", () => {
    render(shell());

    expect(screen.getByRole("region", { name: "Chat" })).toBeInTheDocument();
    expect(screen.getByRole("tabpanel", { name: "Preview" })).toBeInTheDocument();
  });

  it("offers both halves of the workbench, with the preview showing first", () => {
    // The preview is what somebody came to watch; the code is what they go looking for.
    render(shell());

    expect(screen.getByRole("tab", { name: "Preview" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Code" })).toHaveAttribute("aria-selected", "false");
  });

  it("shows the code when its tab is pressed", () => {
    render(shell());

    fireEvent.click(screen.getByRole("tab", { name: "Code" }));

    expect(screen.getByRole("tab", { name: "Code" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("region", { name: "Files" })).toBeVisible();
  });

  it("gives the whole window to the workbench when the chat is hidden", () => {
    render(shell());

    fireEvent.click(screen.getByRole("button", { name: /hide chat/i }));

    expect(screen.queryByRole("region", { name: "Chat" })).toBeNull();
    expect(screen.getByRole("button", { name: /show chat/i })).toBeInTheDocument();
  });

  it("keeps where the job stands on screen once the chat is hidden", async () => {
    // The strip that carries it lives inside the chat pane, so collapsing the chat used to take
    // the one signal saying whether the project works off the screen — precisely when the
    // preview is most dominant. The bar mirrors it for that reason.
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

    const bar = () =>
      within(screen.getByRole("banner")).getByRole("status", { name: /job phase/i });
    expect(bar()).toHaveTextContent(/verifying/i);

    fireEvent.click(screen.getByRole("button", { name: /hide chat/i }));

    expect(screen.queryByRole("region", { name: "Chat" })).toBeNull();
    expect(bar()).toHaveTextContent(/verifying/i);
  });

  it("lets the divider be moved without a mouse", () => {
    // A drag handle that only answers a pointer is unreachable for anybody who does not use
    // one, and this one decides how much of the screen the transcript gets.
    render(shell());

    const divider = screen.getByRole("separator", { name: /chat width/i });
    const before = Number(divider.getAttribute("aria-valuenow"));

    fireEvent.keyDown(divider, { key: "ArrowRight" });

    expect(Number(divider.getAttribute("aria-valuenow"))).toBeGreaterThan(before);
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

  it("renders a banner identifying the product", () => {
    render(shell());

    expect(screen.getByRole("banner")).toHaveTextContent(/nap/i);
  });

  it("offers a way back to the dashboard", () => {
    // Without it the workspace is a dead end: the URL is the only route out, and nobody types
    // one to leave a page.
    render(shell());

    expect(screen.getByRole("link", { name: /nap/i })).toHaveAttribute("href", "/dashboard");
  });
});
