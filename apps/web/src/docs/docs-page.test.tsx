import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DocsPage } from "./docs-page.tsx";
import { SECTIONS } from "./sections.tsx";

/**
 * What is worth asserting on a page of static prose, and what is not.
 *
 * Not the prose: it will be edited a dozen times and a test that repeats it is churn wearing a
 * green tick. What can actually break is reachability — an anchor pointing at a section that has
 * been renamed, a heading that stops being a heading, the index and the document falling out of
 * step — and every one of those is invisible until somebody clicks.
 */

describe("the document", () => {
  it("renders every section as a landmark with a heading", () => {
    render(<DocsPage />);

    for (const section of SECTIONS) {
      // By role and accessible name, so this also fails if the section stops being reachable to
      // somebody navigating by landmark or by heading.
      expect(screen.getByRole("region", { name: section.title })).toBeInTheDocument();
      expect(screen.getByRole("heading", { level: 2, name: section.title })).toBeInTheDocument();
    }
  });

  it("keeps the sections in the order the list declares", () => {
    render(<DocsPage />);
    const headings = screen
      .getAllByRole("heading", { level: 2 })
      .map((heading) => heading.textContent);

    expect(headings).toEqual(SECTIONS.map((section) => section.title));
  });

  it("has one page title above them", () => {
    render(<DocsPage />);

    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  });
});

describe("the index", () => {
  const index = () => within(screen.getByRole("navigation", { name: /on this page/i }));

  it("offers one link per section", () => {
    render(<DocsPage />);

    expect(index().getAllByRole("link")).toHaveLength(SECTIONS.length);
  });

  it("points every link at a section that is actually on the page", () => {
    // The one failure this page has that nothing else would catch: a link to `#durable-jobs` when
    // the section calls itself something else scrolls nowhere and reports nothing.
    const { container } = render(<DocsPage />);

    for (const link of index().getAllByRole("link")) {
      const href = link.getAttribute("href");
      expect(href).toMatch(/^#/);
      expect(container.querySelector(`[id="${href?.slice(1)}"]`)).not.toBeNull();
    }
  });
});

describe("the frame", () => {
  it("renders with no router and no session", () => {
    // The whole route is server-rendered and stateless, which is what lets it be asserted on like
    // this. A hook that needed a session would fail here rather than in production.
    expect(() => render(<DocsPage />)).not.toThrow();
  });

  it("carries the light ink ramp, scoped to the page", () => {
    const { container } = render(<DocsPage />);

    expect(container.firstElementChild).toHaveClass("ai-stage-ink");
  });

  it("says which page the bar is on", () => {
    render(<DocsPage />);

    expect(
      within(screen.getByRole("banner")).getByRole("link", { name: /^docs$/i }),
    ).toHaveAttribute("aria-current", "page");
  });

  it("offers a way back into the product rather than a Sign in it cannot resolve", () => {
    render(<DocsPage />);
    const bar = within(screen.getByRole("banner"));

    expect(bar.getByRole("link", { name: /open nap/i })).toHaveAttribute("href", "/");
    expect(bar.queryByRole("link", { name: /sign in/i })).not.toBeInTheDocument();
  });
});

describe("the recording", () => {
  // The only asset the page loads, and the only reference on it a compiler cannot follow: `src`
  // and `poster` are plain strings resolved by the browser against `apps/web/public` at request
  // time. Rename or forget to commit either file and the page still renders, still passes every
  // test above, and serves a dead player — so this reaches for the filesystem, which is also why
  // it is the one place here that queries by tag rather than by role.
  // Walked up from the working directory rather than resolved from `import.meta.url`, which in
  // the jsdom environment is an http:// URL and cannot be turned back into a path.
  const publicDir = (() => {
    for (let dir = process.cwd(); dir !== dirname(dir); dir = dirname(dir)) {
      const candidate = join(dir, "apps/web/public");
      if (existsSync(candidate)) return candidate;
    }
    throw new Error("could not find apps/web/public from the working directory");
  })();

  it("points at files that are actually in the deployed bundle", () => {
    const { container } = render(<DocsPage />);
    const video = container.querySelector("video");

    expect(video).not.toBeNull();
    for (const attribute of ["src", "poster"] as const) {
      const path = video?.getAttribute(attribute);
      expect(path).toMatch(/^\//);
      expect({ [attribute]: path, exists: existsSync(join(publicDir, path ?? "")) }).toEqual({
        [attribute]: path,
        exists: true,
      });
    }
  });

  it("has an accessible name, and does not start playing on its own", () => {
    render(<DocsPage />);
    const figure = screen.getByRole("figure", { name: /recorded nap session/i });

    expect(within(figure).getByLabelText(/recorded nap session/i)).not.toHaveAttribute("autoplay");
  });
});
