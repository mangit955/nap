import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LandingDesktopDemo } from "./landing-desktop-demo.tsx";
import { storyEvents, storyThread } from "./story-demo-data.ts";
import type { StoryChapter, StoryDemoMessage, StoryThreadId } from "./story-demo-protocol.ts";

// File identity uses the real FilePanel and cache; only syntax rendering is replaced.
vi.mock("next/dynamic", () => ({
  default:
    () =>
    ({ contents }: { contents: string }) => <pre>{contents}</pre>,
}));

const initialWidth = window.innerWidth;

function viewport(width: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width, writable: true });
  vi.spyOn(window, "matchMedia").mockImplementation((query) => {
    const maximum = /max-width: (\d+)px/.exec(query);
    return {
      matches: maximum !== null && window.innerWidth <= Number(maximum[1]),
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: () => true,
    };
  });
}

function stage(chapter: StoryChapter) {
  act(() => {
    window.dispatchEvent(
      new MessageEvent("message", {
        source: window.parent,
        origin: window.location.origin,
        data: { source: "nap-story-demo", type: "stage", chapter } satisfies StoryDemoMessage,
      }),
    );
  });
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: initialWidth,
    writable: true,
  });
  localStorage.clear();
  sessionStorage.clear();
});

describe("the native landing demo's sidebar preferences", () => {
  it("does not restore the real app's saved session-list scroll", () => {
    viewport(1280);
    sessionStorage.setItem("nap.sidebar.scroll", "640");
    const read = vi.spyOn(Storage.prototype, "getItem");
    render(<LandingDesktopDemo initialChapter="ready" />);

    expect(read).not.toHaveBeenCalledWith("nap.sidebar.scroll");
    expect(screen.getByRole("region", { name: "Session list" }).scrollTop).toBe(0);
  });

  it("keeps demo session-list scrolling out of the real app's saved scroll", () => {
    viewport(1280);
    sessionStorage.setItem("nap.sidebar.scroll", "640");
    const write = vi.spyOn(Storage.prototype, "setItem");
    render(<LandingDesktopDemo initialChapter="ready" />);
    const list = screen.getByRole("region", { name: "Session list" });

    list.scrollTop = 120;
    fireEvent.scroll(list);

    expect(list.scrollTop).toBe(120);
    expect(write).not.toHaveBeenCalledWith("nap.sidebar.scroll", expect.anything());
    expect(sessionStorage.getItem("nap.sidebar.scroll")).toBe("640");
  });

  it("does not clamp the real app's saved width when mounted in a compact viewport", () => {
    viewport(390);
    localStorage.setItem("nap.sidebar.width", "320");
    render(<LandingDesktopDemo />);

    expect(screen.getByRole("separator", { name: "Sidebar width" })).toBeInTheDocument();
    expect(localStorage.getItem("nap.sidebar.width")).toBe("320");
  });

  it("starts with its own expanded sidebar even when the real app saved a collapsed one", () => {
    viewport(1280);
    localStorage.setItem("nap.sidebar.collapsed", "true");
    render(<LandingDesktopDemo />);

    expect(screen.getByRole("button", { name: "Collapse sidebar" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(localStorage.getItem("nap.sidebar.collapsed")).toBe("true");
  });

  it("keeps demo collapse and expansion out of the real app's preferences", () => {
    viewport(1280);
    localStorage.setItem("nap.sidebar.collapsed", "false");
    render(<LandingDesktopDemo />);

    fireEvent.click(screen.getByRole("button", { name: "Collapse sidebar" }));
    expect(screen.getByRole("button", { name: "Expand sidebar" })).toBeInTheDocument();
    expect(localStorage.getItem("nap.sidebar.collapsed")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "Expand sidebar" }));
    expect(screen.getByRole("separator", { name: "Sidebar width" })).toBeInTheDocument();
    expect(localStorage.getItem("nap.sidebar.collapsed")).toBe("false");
  });

  it("resizes its sidebar locally without replacing the real app's saved width", () => {
    viewport(1280);
    localStorage.setItem("nap.sidebar.width", "320");
    render(<LandingDesktopDemo />);
    const handle = screen.getByRole("separator", { name: "Sidebar width" });
    const previous = Number(handle.getAttribute("aria-valuenow"));

    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(Number(handle.getAttribute("aria-valuenow"))).toBe(previous + 16);
    expect(localStorage.getItem("nap.sidebar.width")).toBe("320");

    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390, writable: true });
    fireEvent(window, new Event("resize"));
    expect(handle).toHaveAttribute("aria-valuenow", "208");
    expect(localStorage.getItem("nap.sidebar.width")).toBe("320");
  });
});

describe("ready demo file identity", () => {
  it.each(["cabins", "launch"] satisfies StoryThreadId[])(
    "shows %s source after Finance without restarting ready previews",
    async (threadId) => {
      viewport(1280);
      const finance = storyThread("finance");
      const target = storyThread(threadId);
      const path = "src/App.tsx";
      const at = "2026-10-25T12:00:00.000Z";
      const financeEvents = storyEvents(finance, finance.prompt, at, true);
      const targetEvents = storyEvents(target, target.prompt, at, true);
      // Equal ready event histories keep this switch from incidentally invalidating the cache.
      expect(targetEvents.map((event) => event.type)).toEqual(
        financeEvents.map((event) => event.type),
      );
      expect(target.project.sessionIds[0]).not.toBe(finance.project.sessionIds[0]);
      expect(finance.files[path]).toContain("SpendingChart");
      expect(target.files[path]).toContain(
        threadId === "cabins" ? "Reserve your quiet" : "Complete launch checklist",
      );
      expect(target.files[path]).not.toBe(finance.files[path]);

      const { container } = render(<LandingDesktopDemo initialChapter="ready" />);
      const frames = [...container.querySelectorAll<HTMLIFrameElement>("iframe")];
      expect(frames).toHaveLength(3);
      const previewWindows = frames.map((frame) => frame.contentWindow);
      expect(previewWindows.every((preview) => preview !== null)).toBe(true);

      fireEvent.click(screen.getByRole("tab", { name: "Files" }));
      fireEvent.click(
        within(screen.getByRole("tabpanel", { name: "Files" })).getByRole("button", {
          name: /App\.tsx/,
        }),
      );
      await waitFor(() =>
        expect(
          within(screen.getByRole("region", { name: `${path} (read-only)` })).getByText(
            /SpendingChart/,
            { selector: "pre" },
          ).textContent,
        ).toBe(finance.files[path]),
      );

      await act(async () => {
        fireEvent.click(screen.getByRole("link", { name: new RegExp(target.project.name) }));
      });

      expect(screen.getByRole("link", { name: new RegExp(target.project.name) })).toHaveAttribute(
        "aria-current",
        "page",
      );
      const retainedFrames = container.querySelectorAll<HTMLIFrameElement>("iframe");
      expect(retainedFrames).toHaveLength(3);
      frames.forEach((frame, index) => {
        expect(retainedFrames[index]).toBe(frame);
        expect(frame.contentWindow).toBe(previewWindows[index]);
      });
      await waitFor(() => {
        const viewer = screen.getByRole("region", { name: `${path} (read-only)` });
        expect(viewer.querySelector("pre")?.textContent).toBe(target.files[path]);
        expect(viewer).not.toHaveTextContent("SpendingChart");
      });
    },
  );
});

describe("compact demo chapter focus", () => {
  it.each(["describe", "build"] satisfies StoryChapter[])(
    "keeps chapter-control focus when the parent advances from %s to the ready preview",
    (initialChapter) => {
      viewport(390);
      render(
        <>
          <button type="button">Walkthrough chapters</button>
          <LandingDesktopDemo initialChapter={initialChapter} />
        </>,
      );
      const chapters = screen.getByRole("button", { name: "Walkthrough chapters" });
      chapters.focus();

      stage("ready");

      expect(screen.getByRole("tab", { name: "Browser" })).toHaveAttribute("aria-selected", "true");
      expect(chapters).toHaveFocus();
    },
  );

  it("allows focus to leave an already open preview for the chapter controls", () => {
    viewport(390);
    render(
      <>
        <button type="button">Walkthrough chapters</button>
        <LandingDesktopDemo initialChapter="ready" />
      </>,
    );
    const browser = screen.getByRole("tab", { name: "Browser" });
    browser.focus();
    const chapters = screen.getByRole("button", { name: "Walkthrough chapters" });
    chapters.focus();

    expect(chapters).toHaveFocus();
    expect(browser).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("region", { name: "Right panel" })).not.toHaveAttribute("aria-modal");
  });
});

describe("compact demo session selection", () => {
  it.each([0, 1])(
    "activates the selected example and closes the drawer for click detail %s",
    async (detail) => {
      viewport(390);
      render(<LandingDesktopDemo />);
      fireEvent.click(screen.getByRole("button", { name: "Open sessions" }));
      const selected = screen.getByRole("link", { name: /Highland stays/ });

      await act(async () => {
        fireEvent.click(selected, { detail });
      });

      expect(selected).toHaveAttribute("aria-current", "page");
      expect(screen.getByRole("button", { name: "Open sessions" })).toHaveAttribute(
        "aria-expanded",
        "false",
      );
      expect(screen.getByRole("main")).not.toHaveAttribute("inert");
      expect(screen.getByRole("tab", { name: "Browser" })).toBeVisible();
    },
  );

  it("closes the drawer when the visitor selects the already active example", async () => {
    viewport(390);
    render(<LandingDesktopDemo initialChapter="build" />);
    fireEvent.click(screen.getByRole("button", { name: "Open sessions" }));
    const selected = screen.getByRole("link", { name: /Personal finance/ });
    expect(selected).toHaveAttribute("aria-current", "page");

    await act(async () => {
      fireEvent.click(selected);
    });

    expect(screen.getByRole("button", { name: "Open sessions" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(screen.getByRole("main")).not.toHaveAttribute("inert");
  });

  it("honors a cancelled session selection without switching the example or closing the drawer", async () => {
    viewport(390);
    render(
      <div onClickCapture={(event) => event.preventDefault()}>
        <LandingDesktopDemo />
      </div>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open sessions" }));
    const selected = screen.getByRole("link", { name: /Highland stays/ });

    await act(async () => {
      fireEvent.click(selected);
    });

    expect(selected).not.toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("button", { name: "Close sessions" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.getByRole("main", { hidden: true })).toHaveAttribute("inert");
  });
});

it("keeps focus on a desktop session selection when the drawer is already closed", async () => {
  viewport(1280);
  render(<LandingDesktopDemo />);
  const selected = screen.getByRole("link", { name: /Highland stays/ });
  selected.focus();

  await act(async () => {
    fireEvent.click(selected);
  });

  expect(selected).toHaveAttribute("aria-current", "page");
  expect(selected).toHaveFocus();
  expect(screen.getByRole("button", { name: "Open sessions" })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
});
