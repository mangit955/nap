import { InMemoryEventBus } from "@nap/db/testing/in-memory-event-bus";
import { InMemoryEventStore } from "@nap/db/testing/in-memory-event-store";
import { InMemoryProjectComputerAccess } from "@nap/db/testing/in-memory-project-computer-access";
import { InMemorySessionStore } from "@nap/db/testing/in-memory-session-store";
import { ProjectComputer } from "@nap/runtime/project-computer";
import { performDesktopAction } from "@nap/sandbox/desktop-input";
import { FakeSandboxDesktop } from "@nap/sandbox/testing/fake-sandbox-desktop";
import { ComputerInputSchema, type HumanComputerAction } from "@nap/shared/computer-access";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApp } from "../../../api/src/app.ts";
import { createLogger } from "../../../api/src/logger.ts";
import type { FetchJson } from "../files/use-project-files.ts";
import { ComputerInputSurface } from "./computer-input-surface.tsx";
import { useComputerControl } from "./use-computer-control.ts";

it.each([true, false])(
  "keeps remote keys and Shift+Escape away from workspace controls, driving=%s",
  (driving) => {
    const bubbled = vi.fn();
    window.addEventListener("keydown", bubbled);
    try {
      render(
        <ComputerInputSurface
          driving={driving}
          available
          sourceKey="vm"
          sendActions={async () => true}
          takeControl={async () => true}
          release={vi.fn()}
        />,
      );
      const input = screen.getByRole("textbox", { name: "Type on the remote computer" });
      if (driving) {
        fireEvent.keyDown(input, { key: "Escape" });
        fireEvent.keyDown(input, { key: "Tab" });
      }
      fireEvent.keyDown(input, { key: "Escape", shiftKey: true });
      expect(bubbled).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("keydown", bubbled);
    }
  },
);

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
function setup(driving = true) {
  const sendActions = vi.fn(async (_actions: readonly HumanComputerAction[]) => true);
  const takeControl = vi.fn(async () => true);
  const release = vi.fn();
  const props = {
    driving,
    available: true,
    sourceKey: "live-a",
    sendActions,
    takeControl,
    release,
  };
  const view = render(<ComputerInputSurface {...props} />);
  const input = screen.getByRole("textbox", { name: "Type on the remote computer" });
  vi.spyOn(input, "getBoundingClientRect").mockReturnValue(new DOMRect(10, 20, 1000, 600));
  // jsdom schedules selectionchange when the hidden textbox receives focus.
  act(() => {
    vi.runOnlyPendingTimers();
  });
  return { ...view, input, sendActions, takeControl, release, props };
}
function click(input: HTMLElement, x: number, y: number, detail = 1) {
  fireEvent.click(input, { clientX: x, clientY: y, detail });
}
it("click anywhere acquires control without forwarding the activation gesture or duplicating application roles", () => {
  const h = setup(false);
  expect(screen.getByText("Click anywhere to drive the computer")).toBeVisible();
  expect(screen.queryByRole("application")).toBeNull();
  click(h.input, 510, 320);
  expect(h.takeControl).toHaveBeenCalledOnce();
  expect(h.sendActions).not.toHaveBeenCalled();
});
it("ignores letterbox and maps centered 1024 by 768 coordinates", () => {
  const h = setup();
  click(h.input, 50, 320);
  act(() => {
    vi.runAllTimers();
  });
  expect(h.sendActions).not.toHaveBeenCalled();
  click(h.input, 510, 320);
  act(() => {
    vi.runAllTimers();
  });
  expect(h.sendActions).toHaveBeenLastCalledWith([
    { action: "left_click", coordinate: [512, 384] },
  ]);
  click(h.input, 909, 619);
  act(() => {
    vi.runAllTimers();
  });
  expect(h.sendActions).toHaveBeenLastCalledWith([
    { action: "left_click", coordinate: [1022, 766] },
  ]);
});
it("a double click sends one double click, without two singles or a triple", () => {
  const h = setup();
  click(h.input, 510, 320, 1);
  click(h.input, 510, 320, 2);
  fireEvent.doubleClick(h.input, { clientX: 510, clientY: 320 });
  click(h.input, 510, 320, 3);
  act(() => {
    vi.runAllTimers();
  });
  expect(h.sendActions).toHaveBeenCalledExactlyOnceWith([
    { action: "double_click", coordinate: [512, 384] },
  ]);
});
it.each(["timer", "key", "text"])(
  "a second click after the first was flushed by %s sends only the remaining click",
  (flush) => {
    const h = setup();
    click(h.input, 510, 320, 1);
    if (flush === "timer") act(() => vi.advanceTimersByTime(450));
    else if (flush === "key") fireEvent.keyDown(h.input, { key: "Enter" });
    else fireEvent.input(h.input, { target: { value: "a" } });
    click(h.input, 510, 320, 2);
    act(() => vi.runOnlyPendingTimers());
    expect(
      h.sendActions.mock.calls
        .flatMap(([actions]) => actions)
        .filter((action) => action.action === "left_click" || action.action === "double_click"),
    ).toStrictEqual([
      { action: "left_click", coordinate: [512, 384] },
      { action: "left_click", coordinate: [512, 384] },
    ]);
  },
);
it("a grant between acquisition clicks does not turn the remaining click into a double", () => {
  const h = setup(false);
  click(h.input, 510, 320, 1);
  h.rerender(<ComputerInputSurface {...h.props} driving />);
  click(h.input, 510, 320, 2);
  act(() => vi.runOnlyPendingTimers());
  expect(h.takeControl).toHaveBeenCalledOnce();
  expect(h.sendActions).toHaveBeenCalledExactlyOnceWith([
    { action: "left_click", coordinate: [512, 384] },
  ]);
});
it("sends right/middle click and bounded wheel input without local menu or clipboard reads", () => {
  const h = setup();
  fireEvent.contextMenu(h.input, { clientX: 510, clientY: 320 });
  fireEvent(
    h.input,
    new MouseEvent("auxclick", { bubbles: true, button: 1, clientX: 510, clientY: 320 }),
  );
  fireEvent.wheel(h.input, { clientX: 510, clientY: 320, deltaY: -100_000 });
  expect(h.sendActions.mock.calls.map(([actions]) => actions)).toStrictEqual([
    [{ action: "right_click", coordinate: [512, 384] }],
    [{ action: "middle_click", coordinate: [512, 384] }],
    [{ action: "scroll", coordinate: [512, 384], scroll_direction: "up", scroll_amount: 100 }],
  ]);
});
it("sends a whole drag only at release and cancels a gesture on pointer cancel", () => {
  const h = setup();
  // jsdom has no PointerEvent; preserve real mouse coordinates for these local events.
  vi.stubGlobal("PointerEvent", MouseEvent);
  fireEvent.pointerDown(h.input, { pointerId: 1, button: 0, clientX: 510, clientY: 320 });
  fireEvent.pointerMove(h.input, { pointerId: 1, buttons: 1, clientX: 710, clientY: 470 });
  expect(h.sendActions).not.toHaveBeenCalled();
  fireEvent.pointerUp(h.input, { pointerId: 1, button: 0, clientX: 710, clientY: 470 });
  click(h.input, 710, 470);
  act(() => {
    vi.runAllTimers();
  });
  expect(h.sendActions).toHaveBeenCalledExactlyOnceWith([
    { action: "left_click_drag", start_coordinate: [512, 384], coordinate: [768, 576] },
  ]);
  fireEvent.pointerDown(h.input, { button: 0, clientX: 510, clientY: 320 });
  fireEvent.pointerCancel(h.input);
  fireEvent.pointerUp(h.input, { button: 0, clientX: 710, clientY: 470 });
  expect(h.sendActions).toHaveBeenCalledOnce();
  vi.unstubAllGlobals();
});
it("uses keysyms for chords and special keys, leaves paste to its explicit event, and Shift Escape exits", () => {
  const h = setup();
  fireEvent.keyDown(h.input, { key: "a", ctrlKey: true });
  fireEvent.keyDown(h.input, { key: "ArrowLeft", altKey: true, shiftKey: true });
  fireEvent.keyDown(h.input, { key: "Escape" });
  fireEvent.keyDown(h.input, { key: "V", ctrlKey: true });
  fireEvent.keyDown(h.input, { key: "Shift", shiftKey: true });
  fireEvent.keyDown(h.input, { key: "Escape", shiftKey: true });
  expect(h.sendActions.mock.calls.map(([actions]) => actions)).toStrictEqual([
    [{ action: "key", text: "ctrl+a" }],
    [{ action: "key", text: "alt+shift+Left" }],
    [{ action: "key", text: "Escape" }],
  ]);
  expect(h.release).toHaveBeenCalledOnce();
});
it("ordinary text, touch input and IME commit once, without sending composing keys", () => {
  const h = setup();
  fireEvent.keyDown(h.input, { key: "a" });
  fireEvent.input(h.input, { target: { value: "a" }, inputType: "insertText", data: "a" });
  fireEvent.compositionStart(h.input);
  fireEvent.keyDown(h.input, { key: "Process", isComposing: true });
  fireEvent.input(h.input, {
    target: { value: "日本" },
    isComposing: true,
    inputType: "insertCompositionText",
  });
  fireEvent.compositionEnd(h.input, { data: "日本" });
  fireEvent.input(h.input, { target: { value: "日本" }, inputType: "insertText", data: "日本" });
  expect(h.sendActions.mock.calls.map(([actions]) => actions)).toStrictEqual([
    [{ action: "type", text: "a" }],
    [{ action: "type", text: "日本" }],
  ]);
});
it("explicit paste is bounded by shared batch/text limits and never repeats Ctrl V", () => {
  const h = setup();
  const text = "a".repeat(2001);
  fireEvent.keyDown(h.input, { key: "v", ctrlKey: true });
  fireEvent.paste(h.input, { clipboardData: { getData: () => text } });
  expect(h.sendActions.mock.calls.map(([actions]) => actions)).toStrictEqual([
    [{ action: "type", text: "a".repeat(2000) }],
    [{ action: "type", text: "a" }],
  ]);
});
it("cancels delayed clicks/composition on source changes, disable, blur and unmount", () => {
  const h = setup();
  click(h.input, 510, 320);
  h.rerender(<ComputerInputSurface {...h.props} sourceKey="live-b" />);
  act(() => {
    vi.runAllTimers();
  });
  expect(h.sendActions).not.toHaveBeenCalled();
  click(h.input, 510, 320);
  fireEvent.blur(h.input);
  act(() => {
    vi.runAllTimers();
  });
  expect(h.sendActions).not.toHaveBeenCalled();
  click(h.input, 510, 320);
  h.rerender(<ComputerInputSurface {...h.props} driving={false} available={false} />);
  act(() => {
    vi.runAllTimers();
  });
  expect(h.sendActions).not.toHaveBeenCalled();
  expect(h.input).toBeDisabled();
  h.unmount();
  expect(vi.getTimerCount()).toBe(0);
});

it("ignores an entire pointer gesture that starts in the letterbox", () => {
  const h = setup();
  vi.stubGlobal("PointerEvent", MouseEvent);
  fireEvent.pointerDown(h.input, { button: 0, clientX: 50, clientY: 320 });
  fireEvent.pointerMove(h.input, { buttons: 1, clientX: 510, clientY: 320 });
  fireEvent.pointerUp(h.input, { button: 0, clientX: 510, clientY: 320 });
  click(h.input, 510, 320);
  act(() => {
    vi.runAllTimers();
  });
  expect(h.sendActions).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});
it("rejects oversized paste without a partial prefix, and keeps Unicode pairs intact", () => {
  const h = setup();
  fireEvent.paste(h.input, { clipboardData: { getData: () => "x".repeat(32_001) } });
  expect(h.sendActions).not.toHaveBeenCalled();
  expect(screen.getByRole("status")).toHaveTextContent("32,000");
  fireEvent.paste(h.input, { clipboardData: { getData: () => `${"a".repeat(1999)}🎉` } });
  expect(h.sendActions.mock.calls.map(([actions]) => actions)).toStrictEqual([
    [{ action: "type", text: "a".repeat(1999) }],
    [{ action: "type", text: "🎉" }],
  ]);
});
it("retires composition on source changes and removes the native wheel listener on unmount", () => {
  const h = setup();
  const remove = vi.spyOn(h.input, "removeEventListener");
  fireEvent.compositionStart(h.input);
  h.rerender(<ComputerInputSurface {...h.props} sourceKey="live-b" />);
  fireEvent.compositionEnd(h.input, { data: "stale" });
  expect(h.sendActions).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  click(h.input, 510, 320);
  h.unmount();
  expect(vi.getTimerCount()).toBe(0);
  expect(remove).toHaveBeenCalledWith("wheel", expect.any(Function));
});
it("Shift Insert delegates only to explicit paste, and typing flushes an earlier click", () => {
  const h = setup();
  click(h.input, 510, 320);
  fireEvent.keyDown(h.input, { key: "Insert", shiftKey: true });
  fireEvent.paste(h.input, { clipboardData: { getData: () => "once" } });
  act(() => {
    vi.runAllTimers();
  });
  expect(h.sendActions.mock.calls.map(([actions]) => actions)).toStrictEqual([
    [{ action: "left_click", coordinate: [512, 384] }],
    [{ action: "type", text: "once" }],
  ]);
});

// Real client queue, API ownership/grant/schema/deadline path and adapter argv. Only
// reservation store and physical X11 host are fakes; no cookies or cloud are used.
async function queuedPaste() {
  const sessionId = "00000000-0000-4000-8000-000000000001";
  const projectId = "00000000-0000-4000-8000-000000000002";
  const desktop = new FakeSandboxDesktop({ bytes: new Uint8Array(), width: 1024, height: 768 });
  const access = new InMemoryProjectComputerAccess();
  access.setProject({
    projectId,
    userId: "owner",
    sessionIds: [sessionId],
    sandboxId: "box",
    revision: "00000000-0000-4000-8000-000000000003",
  });
  const computer = new ProjectComputer({ access, transport: desktop.transport });
  const app = createApp({
    logger: createLogger({ level: "silent" }, { write: () => {} }),
    authenticate: async () => ({ userId: "owner", isAnonymous: false }),
    stream: {
      store: new InMemoryEventStore(),
      bus: new InMemoryEventBus(),
      upgradeWebSocket: async () => new Response(),
    },
    computerAccess: {
      sessions: new InMemorySessionStore([
        {
          sessionId,
          projectId,
          userId: "owner",
          sandboxId: "box",
        },
      ]),
      desktop,
      computer,
      access,
      secret: "local-test-only",
    },
  });
  let budget = 0;
  let elapsed = 0;
  let timeout = new AbortController();
  const budgets: number[] = [];
  vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
    budgets.push(ms);
    budget = ms;
    elapsed = 0;
    timeout = new AbortController();
    return timeout.signal;
  });
  const physical: { kind: string; duration: number }[] = [];
  vi.spyOn(desktop, "act").mockImplementation(async (_sandbox, action, signal) => {
    try {
      const value = await performDesktopAction(
        action,
        {
          async xdotool(argv, options) {
            const duration =
              argv[0] === "type"
                ? Number(argv[argv.indexOf("--delay") + 1]) * (options?.input?.length ?? 0)
                : 0;
            elapsed += duration;
            physical.push({ kind: action.action, duration });
            if (elapsed >= budget) timeout.abort();
            signal?.throwIfAborted();
            return "";
          },
          sleep: async () => {},
          observe: async () => "",
          zoom: async () => {},
        },
        signal,
      );
      return { ok: true, value };
    } catch {
      return { ok: false, error: { code: "timeout", message: "Modeled deadline" } };
    }
  });
  const requests: { actions: HumanComputerAction[]; ack: () => void; status?: number }[] = [];
  const fetcher: FetchJson = async (url, init) => {
    let ack = () => {};
    const gate = new Promise<void>((resolve) => {
      ack = resolve;
    });
    const record = url.endsWith("/input")
      ? {
          actions: ComputerInputSchema.parse(JSON.parse(String(init?.body))).actions,
          ack,
          status: 0,
        }
      : null;
    if (record) requests.push(record);
    const response = await app.request(new URL(url).pathname, init);
    if (record) {
      record.status = response.status;
      await gate;
    }
    return response;
  };
  function Client({ sourceKey }: { sourceKey: string }) {
    const control = useComputerControl({
      sessionId,
      sourceKey,
      active: true,
      connected: true,
      busy: false,
      fetch: fetcher,
    });
    return (
      <>
        <ComputerInputSurface {...control} sourceKey={sourceKey} />
        <output data-driving={control.driving}>{control.status}</output>
      </>
    );
  }
  const view = render(<Client sourceKey="a" />);
  await act(async () => {});
  const input = screen.getByRole("textbox");
  fireEvent.keyDown(input, { key: "Enter" });
  await act(async () => {});
  expect(view.container.querySelector("output")).toHaveAttribute("data-driving", "true");
  return {
    ...view,
    input,
    requests,
    physical,
    budgets,
    async ack(index: number) {
      await act(async () => {
        requests[index]?.ack();
      });
    },
    changeSource() {
      view.rerender(<Client sourceKey="b" />);
    },
  };
}

it("a maximum paste uses separately acknowledged API deadlines before later keyboard and mouse input", async () => {
  const h = await queuedPaste();
  vi.spyOn(h.input, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 1024, 768));
  // Distinct chunks prove the original order and contents, without logging either.
  const chunks = Array.from({ length: 16 }, (_, index) =>
    String.fromCharCode(65 + index).repeat(2000),
  );
  fireEvent.paste(h.input, { clipboardData: { getData: () => chunks.join("") } });
  fireEvent.keyDown(h.input, { key: "Enter" });
  fireEvent.contextMenu(h.input, { clientX: 512, clientY: 384 });
  await act(async () => {});
  expect(h.requests).toHaveLength(1);
  for (const [index, text] of chunks.entries()) {
    expect(h.requests[index]?.actions).toHaveLength(1);
    const action = h.requests[index]?.actions[0];
    expect(action?.action).toBe("type");
    expect(action?.action === "type" && action.text === text).toBe(true);
    expect(h.requests[index]?.status).toBe(200);
    expect(h.requests).toHaveLength(index + 1);
    await h.ack(index);
  }
  expect(h.requests[16]?.actions).toStrictEqual([{ action: "key", text: "Return" }]);
  await h.ack(16);
  expect(h.requests[17]?.actions).toStrictEqual([
    { action: "right_click", coordinate: [512, 384] },
  ]);
  await h.ack(17);
  expect(
    h.physical.filter((action) => action.kind === "type").map((action) => action.duration),
  ).toStrictEqual(Array(16).fill(2000));
  expect(h.budgets).toStrictEqual(Array(18).fill(5000));
  expect(h.container.querySelector("output")).toHaveAttribute("data-driving", "true");
});

it.each(["failure", "source", "expiry"])(
  "queued paste discards every unsent chunk on %s without replay",
  async (stop) => {
    const h = await queuedPaste();
    fireEvent.paste(h.input, { clipboardData: { getData: () => "x".repeat(32_000) } });
    fireEvent.keyDown(h.input, { key: "Enter" });
    await act(async () => {});
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]?.actions).toHaveLength(1);
    if (stop === "failure") {
      // The next real API request fails after the first chunk's acknowledgement.
      vi.spyOn(AbortSignal, "timeout").mockReturnValue(AbortSignal.abort());
      await h.ack(0);
      expect(h.requests[1]?.status).toBe(503);
      await h.ack(1);
    } else {
      if (stop === "source") h.changeSource();
      else
        await act(async () => {
          await vi.advanceTimersByTimeAsync(60_000);
        });
      await h.ack(0);
    }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(h.requests).toHaveLength(stop === "failure" ? 2 : 1);
    expect(h.container.querySelector("output")).toHaveAttribute("data-driving", "false");
  },
);
