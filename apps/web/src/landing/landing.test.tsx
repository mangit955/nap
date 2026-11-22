import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FEATURED_REPLAY_PATH } from "../replay/featured.ts";
import { REPO_URL } from "./github-button.tsx";
import { type AuthState, Landing } from "./landing.tsx";

function show(auth: AuthState) {
  return render(<Landing auth={auth} hero={<p>hero</p>} />);
}

const bar = () => within(screen.getByRole("banner"));

it("eases a wheel gesture over several frames and releases the frame on unmount", () => {
  vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance"] });
  const now = vi.spyOn(performance, "now");
  let position = 0;
  const scrollY = vi.spyOn(window, "scrollY", "get").mockImplementation(() => position);
  const scrollHeight = vi
    .spyOn(document.documentElement, "scrollHeight", "get")
    .mockReturnValue(4000);
  const scrollTo = vi
    .spyOn(window, "scrollTo")
    .mockImplementation((options?: ScrollToOptions | number) => {
      if (typeof options === "object") position = Math.round(options.top ?? 0);
    });
  const { unmount } = show("signed-out");
  try {
    const main = screen.getByRole("main");
    const wheel = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 240 });
    now.mockReturnValueOnce(20);
    main.dispatchEvent(wheel);

    expect(wheel.defaultPrevented).toBe(true);
    expect(position).toBe(0);
    vi.advanceTimersToNextFrame();
    expect(position).toBe(0);
    vi.advanceTimersToNextFrame();
    expect(position).toBeGreaterThan(0);
    expect(position).toBeLessThan(240);
    vi.advanceTimersByTime(500);
    expect(position).toBe(240);

    main.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 240 }));
    unmount();
    vi.advanceTimersByTime(500);
    expect(position).toBe(240);
  } finally {
    unmount();
    now.mockRestore();
    scrollY.mockRestore();
    scrollHeight.mockRestore();
    scrollTo.mockRestore();
    vi.useRealTimers();
  }
});

describe("before the session has resolved", () => {
  it("offers no way in from the bar", () => {
    show("pending");
    expect(bar().queryByRole("link", { name: /sign in/i })).not.toBeInTheDocument();
    expect(bar().queryByRole("link", { name: /get started/i })).not.toBeInTheDocument();
  });

  it("still shows the hero, because it is the page", () => {
    show("pending");
    expect(screen.getByText("hero")).toBeInTheDocument();
  });
});

describe("signed out", () => {
  it("offers both halves of a way in", () => {
    show("signed-out");
    expect(bar().getByRole("link", { name: /sign in/i })).toHaveAttribute("href", "/sign-in");
    expect(bar().getByRole("link", { name: /get started/i })).toHaveAttribute("href", "/sign-up");
  });
});

describe("the repository link", () => {
  it("points at the source", () => {
    show("signed-out");
    expect(bar().getByRole("link", { name: /^github$/i })).toHaveAttribute("href", REPO_URL);
  });

  it("is there before the session resolves, because it is right either way", () => {
    show("pending");
    expect(bar().getByRole("link", { name: /^github$/i })).toBeInTheDocument();
  });
});

describe("the bar's links", () => {
  it("lead to the page's own sections and to the docs", () => {
    show("signed-out");
    const nav = within(bar().getByRole("navigation", { name: "Front page" }));
    const links = nav
      .getAllByRole("link")
      .map((link) => [link.textContent, link.getAttribute("href")]);
    expect(links).toEqual([
      ["Product", "#product"],
      ["Built with nap", "#built"],
      ["Changelog", "#changelog"],
      ["Docs", "/docs"],
    ]);
    for (const [, href] of links.slice(0, 3)) {
      expect(document.getElementById(String(href).slice(1))).not.toBeNull();
    }
  });
});

describe("the way into the docs", () => {
  it("is offered from the bar", () => {
    show("signed-out");
    const nav = within(bar().getByRole("navigation", { name: "Front page" }));
    expect(nav.getByRole("link", { name: /^docs$/i })).toHaveAttribute("href", "/docs");
  });

  it("is offered again at the foot of the page, where the bar has long gone", () => {
    show("signed-out");
    const footer = within(screen.getByRole("contentinfo"));
    expect(footer.getByRole("link", { name: /^how it works$/i })).toHaveAttribute("href", "/docs");
  });
});

describe("the frame", () => {
  it("has exactly one main landmark", () => {
    show("signed-out");
    expect(screen.getAllByRole("main")).toHaveLength(1);
  });

  it("has exactly one footer, outside the main content", () => {
    show("signed-out");
    expect(within(screen.getByRole("main")).queryByRole("contentinfo")).not.toBeInTheDocument();
    expect(screen.getByRole("contentinfo")).toBeInTheDocument();
  });

  it("carries the page's story under the hero, in order", () => {
    show("signed-out");
    const sections = [...screen.getByRole("main").querySelectorAll(":scope > section")].map(
      (section) => section.id,
    );
    expect(sections).toEqual(["product", "built", "changelog", "start"]);
  });

  it("names every section, and keeps the serif for the closing line alone", () => {
    show("signed-out");
    expect(screen.getByRole("region", { name: "Product" })).toBeInTheDocument();
    for (const name of [/^built with nap$/i, /^changelog$/i, /^build your first app\.$/i]) {
      expect(screen.getByRole("heading", { level: 2, name })).toBeInTheDocument();
    }
    const serif = [...document.querySelectorAll("main h2.lp-serif")].map((h) => h.textContent);
    expect(serif).toEqual(["Build your first app."]);
  });

  it("scopes its dark colours to itself rather than to the whole app", () => {
    const { container } = show("signed-out");
    expect(container.firstElementChild).toHaveClass("landing");
  });

  it("credits the photographs it stands on", () => {
    show("signed-out");
    const footer = within(screen.getByRole("contentinfo"));
    expect(footer.getByText(/CC BY-SA 4\.0/)).toBeInTheDocument();
  });
});

describe("the footer", () => {
  it("links the engineering reports, which the page itself no longer quotes", () => {
    show("signed-out");
    const footer = within(screen.getByRole("contentinfo"));
    expect(footer.getByRole("link", { name: /engineering reports/i })).toHaveAttribute(
      "href",
      `${REPO_URL}/blob/main/docs/scaling-cluster.md`,
    );
  });

  it("keeps a recorded session one click from the front page", () => {
    show("signed-out");
    const footer = within(screen.getByRole("contentinfo"));
    expect(footer.getByRole("link", { name: /watch a real session/i })).toHaveAttribute(
      "href",
      FEATURED_REPLAY_PATH,
    );
  });
});
