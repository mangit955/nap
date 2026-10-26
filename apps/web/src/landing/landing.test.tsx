import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { REPO_URL } from "./github-button.tsx";
import { type AuthState, Landing } from "./landing.tsx";

function show(auth: AuthState) {
  return render(<Landing auth={auth} hero={<p>hero</p>} />);
}

const bar = () => within(screen.getByRole("banner"));

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
    expect(bar().getByRole("link", { name: /star on github/i })).toHaveAttribute("href", REPO_URL);
  });

  it("is there before the session resolves, because it is right either way", () => {
    show("pending");
    expect(bar().getByRole("link", { name: /star on github/i })).toBeInTheDocument();
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
    expect(footer.getByRole("link", { name: /^docs$/i })).toHaveAttribute("href", "/docs");
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
    const sections = screen
      .getAllByRole("region")
      .map((region) => region.getAttribute("aria-labelledby"));
    expect(sections).toEqual(["why-title", "features-title", "measured-title", "start-title"]);
  });

  it("names every section with a heading of its own", () => {
    show("signed-out");
    for (const name of [
      /you describe it/i,
      /built to work alone/i,
      /built to keep going/i,
      /describe it tonight/i,
    ]) {
      expect(screen.getByRole("heading", { level: 2, name })).toBeInTheDocument();
    }
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

describe("the measurements", () => {
  it("pairs measured results with their report and scope", () => {
    show("signed-out");
    const region = within(screen.getByRole("region", { name: /built to keep going/i }));
    expect(region.getByText("Turns completed")).toBeInTheDocument();
    expect(region.getByText(/2,422/)).toBeInTheDocument();
    expect(region.getByRole("link", { name: /read the cluster report/i })).toHaveAttribute(
      "href",
      `${REPO_URL}/blob/main/docs/scaling-cluster.md`,
    );
    expect(region.getByText(/24 August 2026/)).toBeInTheDocument();
  });
});
