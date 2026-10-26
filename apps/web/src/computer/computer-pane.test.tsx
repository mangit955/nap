import type { StoredEvent } from "@nap/shared/ports/event-store";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { ComputerPane } from "./computer-pane.tsx";
import type { RfbConnection, RfbFactory } from "./live-desktop-frame.tsx";

it("allows owner control only on a connected live desktop and retires it when a turn starts", async () => {
  const client = {
    viewOnly: false,
    resizeSession: true,
    scaleViewport: false,
    focusOnClick: true,
    background: "",
    qualityLevel: 0,
    compressionLevel: 0,
    addEventListener: vi.fn<RfbConnection["addEventListener"]>(),
    removeEventListener: vi.fn<RfbConnection["removeEventListener"]>(),
    disconnect: vi.fn(),
  } satisfies RfbConnection;
  const createRfb: RfbFactory = () => client;
  const fetchJson = vi.fn(async (url: string, init?: RequestInit) =>
    Response.json(
      url.endsWith("stream")
        ? {
            url: "wss://desktop.test/websockify",
            password: "private-password",
            width: 1024,
            height: 768,
          }
        : init?.method === "POST"
          ? { grant: "private-grant", expiresAt: Date.now() + 60000 }
          : { available: true },
    ),
  );
  const props = {
    events: [],
    selectedSeq: null,
    onSeek: vi.fn(),
    sessionId: "session",
    sandboxId: "vm",
    fetchJson,
    createRfb,
  };
  const view = render(<ComputerPane {...props} />);
  expect(screen.getByRole("button", { name: "Take control of Nap's computer" })).toBeDisabled();
  await waitFor(() => expect(client.addEventListener).toHaveBeenCalled());
  const connected = client.addEventListener.mock.calls.find(([name]) => name === "connect")?.[1];
  if (!connected) throw new Error("Missing connection listener");
  act(() => connected(new CustomEvent("connect")));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Take control of Nap's computer" })).toBeEnabled(),
  );
  fireEvent.click(screen.getByRole("button", { name: "Take control of Nap's computer" }));
  await screen.findByRole("button", { name: "Release control" });
  const remote = screen.getByRole("application", { name: "Remote computer" });
  expect(remote).toContainElement(
    screen.getByRole("textbox", { name: "Type on the remote computer" }),
  );
  view.rerender(<ComputerPane {...props} busy />);
  expect(screen.getByRole("button", { name: "Take control of Nap's computer" })).toBeDisabled();
  expect(screen.getByText(/A turn is running in this project/)).toBeVisible();
  expect(screen.queryByRole("button", { name: "Release control" })).not.toBeInTheDocument();
  expect(client.viewOnly).toBe(true);
  expect(document.body.textContent).not.toMatch(/private-grant|private-password/);
});

const frame: StoredEvent = {
  type: "computer.screenshot",
  sessionId: "session",
  turnId: "turn",
  seq: 3,
  createdAt: "2026-10-24T00:00:00Z",
  payload: { toolCallId: "screen", key: "private-key", width: 1024, height: 768 },
};
it("shows a named computer with a private screenshot and navigable history controls", () => {
  const seek = vi.fn();
  render(<ComputerPane events={[frame, { ...frame, seq: 6 }]} selectedSeq={null} onSeek={seek} />);
  expect(screen.getByRole("application", { name: "Remote computer" })).toBeInTheDocument();
  expect(screen.getByRole("img", { name: "Computer screenshot" })).toHaveAttribute(
    "crossorigin",
    "use-credentials",
  );
  expect(screen.getByRole("img", { name: "Computer screenshot" }).getAttribute("src")).toContain(
    "/sessions/session/computer/screenshots/6",
  );
  expect(screen.getByRole("slider", { name: "Session timeline" })).toHaveValue("6");
  fireEvent.click(screen.getByRole("button", { name: "Previous event" }));
  expect(seek).toHaveBeenLastCalledWith(3);
  expect(screen.getByRole("combobox", { name: "Stream quality" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Full screen" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Open computer in new window" })).toBeInTheDocument();
});
it("says what happened and when, at the shown point and wherever the timeline is hovered", () => {
  const prompt: StoredEvent = {
    type: "user.message",
    sessionId: "session",
    turnId: "turn",
    seq: 1,
    createdAt: "2026-10-24T06:46:00Z",
    payload: { text: "Check the sign-in page" },
  };
  const call: StoredEvent = {
    type: "tool.call",
    sessionId: "session",
    turnId: "turn",
    seq: 2,
    createdAt: "2026-10-24T06:47:00Z",
    payload: {
      toolCallId: "screen",
      toolName: "computer",
      input: { actions: [{ action: "left_click", coordinate: [10, 20] }] },
    },
  };
  const local = (at: string) =>
    new Date(at).toLocaleString([], { dateStyle: "medium", timeStyle: "medium" });
  render(<ComputerPane events={[prompt, call, frame]} selectedSeq={3} onSeek={() => {}} />);
  const shown = `Clicked at (10, 20) · ${local(call.createdAt)}`;
  expect(screen.getByText(shown)).toBeVisible();
  const timeline = screen.getByRole("slider", { name: "Session timeline" });
  expect(timeline).toHaveAttribute("aria-valuetext", shown);
  timeline.getBoundingClientRect = () => DOMRect.fromRect({ x: 0, width: 300 });
  fireEvent.mouseMove(timeline, { clientX: 100 });
  expect(screen.getByRole("tooltip")).toHaveTextContent(
    `${local(prompt.createdAt)}Check the sign-in page`,
  );
  fireEvent.mouseLeave(timeline);
  expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
});
it("keeps a long prompt and a many-action step to one short line", () => {
  const long: StoredEvent = {
    type: "user.message",
    sessionId: "session",
    turnId: "turn",
    seq: 1,
    createdAt: "2026-10-24T06:46:00Z",
    payload: { text: `${"Check the sign-in page ".repeat(10)}\nthen the dashboard` },
  };
  const view = render(<ComputerPane events={[long, frame]} selectedSeq={3} onSeek={() => {}} />);
  const timeline = screen.getByRole("slider", { name: "Session timeline" });
  const said = timeline.getAttribute("aria-valuetext") ?? "";
  expect(said).toMatch(/^Check the sign-in page .{50,}… · /);
  expect(said).not.toContain("dashboard");
  const call: StoredEvent = {
    type: "tool.call",
    sessionId: "session",
    turnId: "turn",
    seq: 2,
    createdAt: "2026-10-24T06:47:00Z",
    payload: {
      toolCallId: "screen",
      toolName: "computer",
      input: {
        actions: [
          { action: "left_click", coordinate: [10, 20] },
          { action: "type", text: "hello" },
          { action: "key", text: "Return" },
        ],
      },
    },
  };
  view.rerender(<ComputerPane events={[long, call, frame]} selectedSeq={3} onSeek={() => {}} />);
  expect(timeline.getAttribute("aria-valuetext")).toMatch(/^Clicked at \(10, 20\) and 2 more · /);
});
it("returns from history to following the latest screenshot", () => {
  const seek = vi.fn();
  render(<ComputerPane events={[frame, { ...frame, seq: 6 }]} selectedSeq={3} onSeek={seek} />);
  fireEvent.click(screen.getByRole("button", { name: "Go to live desktop" }));
  expect(seek).toHaveBeenCalledWith(null);
  fireEvent.click(screen.getByRole("button", { name: "Next event" }));
  expect(seek).toHaveBeenCalledWith(6);
});
it("distinguishes a waiting computer from a missing historical frame", () => {
  const view = render(<ComputerPane events={[]} selectedSeq={null} onSeek={() => {}} />);
  expect(screen.getByRole("status")).toHaveTextContent("Waiting for Nap's computer…");
  view.rerender(<ComputerPane events={[frame]} selectedSeq={0} onSeek={() => {}} />);
  expect(screen.getByRole("status")).toHaveTextContent(
    "No screenshot is available at this point in history.",
  );
});
it("shows loading and retry states without allowing stale image loads to settle a newer frame", () => {
  const view = render(<ComputerPane events={[frame]} selectedSeq={null} onSeek={() => {}} />);
  const old = screen.getByRole("img", { name: "Computer screenshot" });
  expect(screen.getByRole("status")).toHaveTextContent("Connecting to Nap's computer…");
  view.rerender(
    <ComputerPane events={[frame, { ...frame, seq: 6 }]} selectedSeq={null} onSeek={() => {}} />,
  );
  fireEvent.load(old);
  expect(screen.getByRole("status")).toHaveTextContent("Connecting to Nap's computer…");
  fireEvent.error(screen.getByRole("img", { name: "Computer screenshot" }));
  expect(screen.getByRole("status")).toHaveTextContent("Failed to connect to Nap's computer");
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  fireEvent.load(screen.getByRole("img", { name: "Computer screenshot" }));
  expect(screen.queryByText("Failed to connect to Nap's computer")).not.toBeInTheDocument();
});

it("recognizes an image that finished before hydration attached its load listener", () => {
  const complete = vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(true);
  const width = vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(1024);
  try {
    render(<ComputerPane events={[frame]} selectedSeq={null} onSeek={() => {}} />);
    expect(screen.queryByText("Connecting to Nap's computer…")).not.toBeInTheDocument();
  } finally {
    complete.mockRestore();
    width.mockRestore();
  }
});

it("connects live view with owner credentials, changes quality and disconnects for history or a hidden pane", async () => {
  const client = {
    viewOnly: false,
    resizeSession: true,
    scaleViewport: false,
    focusOnClick: true,
    background: "",
    qualityLevel: 0,
    compressionLevel: 0,
    addEventListener: vi.fn<RfbConnection["addEventListener"]>(),
    removeEventListener: vi.fn<RfbConnection["removeEventListener"]>(),
    disconnect: vi.fn(),
  } satisfies RfbConnection;
  const createRfb = vi.fn<RfbFactory>(() => client);
  const fetchJson = vi.fn(async () =>
    Response.json({
      url: "wss://desktop.test/websockify",
      password: "private-password",
      width: 1024,
      height: 768,
    }),
  );
  const props = {
    events: [frame],
    onSeek: vi.fn(),
    sessionId: "session",
    sandboxId: "vm",
    fetchJson,
    createRfb,
  };
  const view = render(<ComputerPane {...props} selectedSeq={null} />);
  await waitFor(() => expect(createRfb).toHaveBeenCalledOnce());
  expect(screen.getAllByRole("application", { name: "Remote computer" })).toHaveLength(1);
  expect(client.viewOnly).toBe(true);
  expect(screen.queryByRole("img", { name: "Computer screenshot" })).not.toBeInTheDocument();
  fireEvent.change(screen.getByRole("combobox", { name: "Stream quality" }), {
    target: { value: "sharp" },
  });
  expect(client.qualityLevel).toBe(9);
  const disconnected = client.addEventListener.mock.calls.find(
    ([type]) => type === "disconnect",
  )?.[1];
  if (!disconnected) throw new Error("Missing disconnect listener");
  act(() => disconnected(new CustomEvent("disconnect")));
  expect(screen.getByRole("status")).toHaveTextContent("Failed to connect to Nap's computer");
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(createRfb).toHaveBeenCalledTimes(2));
  expect(fetchJson).toHaveBeenCalledTimes(2);
  view.rerender(<ComputerPane {...props} selectedSeq={3} />);
  expect(client.disconnect).toHaveBeenCalledTimes(2);
  expect(screen.getByRole("img", { name: "Computer screenshot" })).toBeInTheDocument();
  expect(screen.getByRole("combobox", { name: "Stream quality" })).toBeDisabled();
  view.rerender(<ComputerPane {...props} selectedSeq={null} active={false} />);
  await act(async () => {});
  expect(fetchJson).toHaveBeenCalledTimes(2);
  expect(document.body.textContent).not.toContain("private-password");
});

it("refreshes owner credentials when a failed transport is retried", async () => {
  const fetchJson = vi.fn(async () => new Response("unavailable", { status: 503 }));
  render(
    <ComputerPane
      events={[]}
      selectedSeq={null}
      onSeek={vi.fn()}
      sessionId="session"
      sandboxId="vm"
      fetchJson={fetchJson}
    />,
  );
  await screen.findByText("Failed to connect to Nap's computer");
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(fetchJson).toHaveBeenCalledTimes(2));
});
