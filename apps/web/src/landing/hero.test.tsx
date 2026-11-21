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
  const text = () => document.body.textContent ?? "";

  it("starts a minute in, working, with the schema open in Code", () => {
    render(<HeroDemo stage="working" />);
    expect(text()).toContain("Working");
    expect(text()).toContain("db/schema.ts");
    expect(
      document.querySelector(".lp-pane[data-shown='true'] .lp-pane-tabs [data-active='true']"),
    ).toHaveTextContent("Code");
    expect(document.querySelector(".lp-pane[data-shown='true'] .ps-ledger")).toBeNull();
    expect(document.querySelector(".lp-hero-changes")).toBeNull();
  });

  it("then verifies, with three of four steps done and the app in Preview", () => {
    render(<HeroDemo stage="verifying" />);
    expect(text()).toContain("Verifying");
    expect(
      document.querySelector(".lp-pane[data-shown='true'] .lp-pane-tabs [data-active='true']"),
    ).toHaveTextContent("Preview");
    expect(document.querySelector(".lp-pane[data-shown='true'] .ps-ledger")).not.toBeNull();
    expect(document.querySelector(".lp-hero-changes")).toBeNull();
  });

  it("ends verified, with the Changes panel over the corner", () => {
    render(<HeroDemo stage="verified" />);
    expect(text()).toContain("Verified");
    expect(text()).toContain("Migrations, tests and the build all passed.");
    expect(document.querySelector(".lp-hero-changes")).toHaveTextContent("3 files · +358");
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
