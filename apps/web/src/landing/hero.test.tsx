import { render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hero } from "./hero.tsx";
import { HeroDemo } from "./hero-demo.tsx";

describe("the front page's hero", () => {
  it("says what the product is in one heading", () => {
    render(<Hero />);
    expect(
      screen.getByRole("heading", { level: 1, name: /describe an app\. then go take a nap\./i }),
    ).toBeInTheDocument();
  });

  it("says it starts from an idea or a repository and builds both halves", () => {
    render(<Hero />);
    expect(screen.getByText(/start from an idea or your github repo/i)).toHaveTextContent(
      /builds the frontend and the backend/i,
    );
  });

  it("offers both ways in, each behind sign-up", () => {
    render(<Hero />);
    expect(screen.getByRole("link", { name: "Start building" })).toHaveAttribute(
      "href",
      "/sign-up",
    );
    expect(screen.getByRole("link", { name: "Connect a repo" })).toHaveAttribute(
      "href",
      "/sign-up",
    );
  });

  it("keeps project creation behind sign-up", () => {
    render(<Hero />);
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("shows the product as one named picture, nothing in it reachable", () => {
    render(<Hero />);
    const picture = screen.getByRole("img", { name: /nap's workspace/i });
    // Inert and hidden: the composer and the sidebar inside are pictures of controls.
    expect(within(picture).queryAllByRole("button")).toHaveLength(0);
    expect(picture.querySelector(".lp-demo-crop")).toHaveAttribute("inert");
  });

  it("puts nothing on the backdrop but the session", () => {
    // An earlier hero laid a mountain mask across the session and hid most of it on a phone. This
    // catches a layer added beside the session; a pseudo-element drawn over it needs layout to
    // see, and `scripts/check-landing.js` hit-tests the window's centre for that.
    render(<Hero />);
    const wall = screen.getByRole("img", { name: /nap's workspace/i }).closest(".lp-wall");
    expect(wall?.children).toHaveLength(1);
  });
});

describe("the hero's three beats", () => {
  // Each beat is read where it is drawn: the bar's phase, the plan's count, the ledger's row in
  // the sidebar, and the pane on show. The sidebar's other rows say "Working" or wear the unread
  // dot at every beat, so nothing here reads the page's text as a whole.
  const bar = () => document.querySelector(".lp-window-header");
  const chat = () => document.querySelector(".lp-window-chat");
  const ledgerRow = () =>
    screen.getByRole("link", { name: /Personal ledger/, hidden: true }).closest("li") ??
    screen.getByRole("link", { name: /Personal ledger/, hidden: true });
  const shownTab = () =>
    document.querySelector(".lp-pane[data-shown='true'] .lp-pane-tabs [data-active='true']");

  it("starts a minute in, working, with the schema open in Code", () => {
    render(<HeroDemo stage="working" />);
    expect(bar()).toHaveTextContent("Working");
    expect(chat()).toHaveTextContent("Plan · 0 of 4 done");
    expect(ledgerRow()).toHaveTextContent(/Working\s*1m/);
    expect(shownTab()).toHaveTextContent("Code");
    expect(document.querySelector(".lp-pane[data-shown='true'] .lp-pane-code")).toHaveTextContent(
      "db/schema.ts",
    );
    expect(document.querySelector(".lp-hero-changes")).toBeNull();
  });

  it("then verifies, with three of four steps done and the app in Preview", () => {
    render(<HeroDemo stage="verifying" />);
    expect(bar()).toHaveTextContent("Verifying");
    expect(chat()).toHaveTextContent("Plan · 3 of 4 done");
    expect(ledgerRow()).toHaveTextContent(/Working\s*9m/);
    expect(shownTab()).toHaveTextContent("Preview");
    expect(document.querySelector(".lp-pane[data-shown='true'] .ps-ledger")).not.toBeNull();
    expect(document.querySelector(".lp-hero-changes")).toBeNull();
  });

  it("ends verified and done, with the Changes panel over the corner", () => {
    render(<HeroDemo stage="verified" />);
    expect(bar()).toHaveTextContent("Verified");
    expect(chat()).toHaveTextContent("Plan · 4 of 4 done");
    expect(chat()).toHaveTextContent("Migrations, tests and the build all passed.");
    expect(ledgerRow()).toHaveTextContent(/Unread.*\+358/);
    expect(document.querySelector(".lp-hero-changes")).toHaveTextContent("3 files · +358");
    expect(document.querySelector(".lp-demo-overlay")).toHaveAttribute("inert");
    // Arriving is the hero's own short fade; the transcript's streaming fade would type it out.
    expect(document.querySelector("[data-streaming]")).toBeNull();
  });
});

describe("the hero's sidebar", () => {
  beforeEach(() => sessionStorage.clear());
  afterEach(() => {
    vi.restoreAllMocks();
    sessionStorage.clear();
  });

  it("never scrolls the page to show its selected row", () => {
    // `scrollIntoView` on the selected row moves the landing page itself, under the reader.
    const scrolled = vi.fn();
    const real = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scrolled;
    try {
      render(<HeroDemo stage="working" />);
      expect(scrolled).not.toHaveBeenCalled();
    } finally {
      Element.prototype.scrollIntoView = real;
    }
  });

  it("does not read or write the real app's saved session-list scroll", () => {
    sessionStorage.setItem("nap.sidebar.scroll", "640");
    const read = vi.spyOn(Storage.prototype, "getItem");
    const write = vi.spyOn(Storage.prototype, "setItem");
    render(<HeroDemo stage="verified" />);
    expect(read).not.toHaveBeenCalledWith("nap.sidebar.scroll");
    expect(write).not.toHaveBeenCalledWith("nap.sidebar.scroll", expect.anything());
  });

  it("marks the made-up repository owners with letters, never a GitHub avatar", () => {
    render(<HeroDemo stage="verified" />);
    expect(screen.getAllByText("Email customers when a payment fails").length).toBeGreaterThan(0);
    expect(document.querySelector("img[src*='github.com']")).toBeNull();
  });
});
