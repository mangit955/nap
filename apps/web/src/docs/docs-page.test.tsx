import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DocsArticle } from "./docs-article.tsx";
import { DocsHome } from "./docs-home.tsx";
import { DocsShell } from "./docs-shell.tsx";
import { LegacyAnchor, legacyTarget } from "./legacy-anchor.tsx";
import { outlineOf } from "./outline.ts";
import { DOCS_HOME, hrefOf, PAGES, READING_ORDER } from "./pages.ts";
import { SECTIONS } from "./sections.tsx";

/**
 * What is worth asserting on pages of static prose, and what is not.
 *
 * Not the prose: it will be edited a dozen times and a test that repeats it is churn wearing a
 * green tick. What can actually break is reachability — a link to a page or heading that is not
 * there, a heading that stops being a heading, an old address that stops landing, a file the
 * page names that has moved — and every one of those is invisible until somebody clicks.
 *
 * Layout, the scroll-spy's measurement and the dialog's native focus trap and Escape are not
 * here: jsdom lays nothing out and implements no `<dialog>`. Those were driven in a real browser.
 */

const router = { push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() };
let pathname = DOCS_HOME;

vi.mock("next/navigation", () => ({
  useRouter: () => router,
  usePathname: () => pathname,
  notFound: () => {
    throw new Error("notFound");
  },
}));

// jsdom parses `<dialog>` and implements none of its methods; these toggle `open` the way the
// real ones do, which is all a test here can observe.
beforeAll(() => {
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  };
});

beforeEach(() => {
  pathname = DOCS_HOME;
  window.location.hash = "";
});
afterEach(() => vi.clearAllMocks());

function renderPage(id: (typeof PAGES)[number]["id"]) {
  const section = SECTIONS.find((candidate) => candidate.id === id);
  if (!section) throw new Error(`no section ${id}`);
  pathname = hrefOf(id);
  return render(
    <DocsShell>
      <DocsArticle section={section} />
    </DocsShell>,
  );
}

// Walked up from the working directory rather than resolved from `import.meta.url`, which in the
// jsdom environment is an http:// URL and cannot be turned back into a path.
const webDir = (() => {
  for (let dir = process.cwd(); dir !== dirname(dir); dir = dirname(dir)) {
    const candidate = join(dir, "apps/web");
    if (existsSync(join(candidate, "public"))) return candidate;
  }
  throw new Error("could not find apps/web from the working directory");
})();

describe.each(PAGES.map((page) => [page.title, page.id] as const))("the %s page", (title, id) => {
  it("has one title, and its subheadings at the level under it", () => {
    renderPage(id);
    const main = within(screen.getByRole("main"));

    expect(main.getAllByRole("heading", { level: 1 }).map((h) => h.textContent)).toEqual([title]);
    const section = SECTIONS.find((candidate) => candidate.id === id);
    const headings = section ? outlineOf(section.Body).headings : [];
    const subheadings = main
      .queryAllByRole("heading", { level: 2 })
      .filter((heading) => headings.some(({ id: anchor }) => anchor === heading.id));
    expect(subheadings.map((heading) => heading.id)).toEqual(headings.map(({ id: a }) => a));
  });

  it("points every 'On this page' link at a heading that is on the page", () => {
    const { container } = renderPage(id);
    const nav = screen.queryByRole("navigation", { name: /on this page/i });
    const links = nav ? within(nav).getAllByRole("link") : [];
    const section = SECTIONS.find((candidate) => candidate.id === id);

    expect(links).toHaveLength(section ? outlineOf(section.Body).headings.length : -1);
    for (const link of links) {
      const href = link.getAttribute("href") ?? "";
      expect(href).toMatch(/^#/);
      expect(container.querySelector(`[id="${href.slice(1)}"]`)).not.toBeNull();
    }
  });

  it("marks itself in the sidebar, and nothing else", () => {
    renderPage(id);
    const sidebar = within(screen.getByRole("navigation", { name: "Docs" }));

    expect(sidebar.getAllByRole("link", { current: "page" }).map((l) => l.textContent)).toEqual([
      title,
    ]);
  });

  it("links to the pages either side of it in reading order", () => {
    renderPage(id);
    const at = READING_ORDER.findIndex((stop) => stop.href === hrefOf(id));
    const pager = within(screen.getByRole("navigation", { name: /previous and next/i }));
    const expected = [READING_ORDER[at - 1], READING_ORDER[at + 1]].flatMap((stop) =>
      stop ? [stop.href] : [],
    );

    expect(pager.getAllByRole("link").map((link) => link.getAttribute("href"))).toEqual(expected);
  });

  it("opens a file that exists when you ask to edit it", () => {
    renderPage(id);
    const edit = screen.getAllByRole("link", { name: /edit (this page )?on github/i });
    for (const link of edit) {
      const path = (link.getAttribute("href") ?? "").split("/edit/main/")[1] ?? "";
      expect({ path, exists: existsSync(join(webDir, "../..", path)) }).toEqual({
        path,
        exists: true,
      });
    }
  });
});

describe("the sidebar", () => {
  it("offers every page, grouped, in reading order", () => {
    render(
      <DocsShell>
        <DocsHome />
      </DocsShell>,
    );
    const sidebar = within(screen.getByRole("navigation", { name: "Docs" }));

    expect(
      sidebar
        .getAllByRole("link")
        .map((link) => link.getAttribute("href"))
        .filter((href) => href?.startsWith(DOCS_HOME)),
    ).toEqual(READING_ORDER.map((stop) => stop.href));
  });
});

describe("the home page", () => {
  it("links a card to every page", () => {
    render(<DocsHome />);
    const cards = screen
      .getAllByRole("link")
      .map((link) => link.getAttribute("href"))
      .filter((href) => href?.startsWith(`${DOCS_HOME}/`));

    for (const { id } of PAGES) expect(cards).toContain(hrefOf(id));
  });
});

describe("the bar", () => {
  it("says the reader is in the docs, and offers no Sign in it cannot resolve", () => {
    render(
      <DocsShell>
        <DocsHome />
      </DocsShell>,
    );
    const bar = within(screen.getByRole("banner"));

    expect(bar.getByRole("link", { name: /^docs$/i, current: "page" })).toHaveAttribute(
      "href",
      DOCS_HOME,
    );
    expect(bar.queryByRole("link", { name: /sign in/i })).not.toBeInTheDocument();
  });
});

describe("old single-page links", () => {
  it("forward every old section anchor to its page", () => {
    for (const { id } of PAGES) expect(legacyTarget(`#${id}`)).toBe(hrefOf(id));
  });

  it("leave anything else alone", () => {
    expect(legacyTarget("")).toBeNull();
    expect(legacyTarget("#nothing-here")).toBeNull();
    expect(legacyTarget("#%E0%A4%A")).toBeNull();
  });

  it("replace the address rather than adding to history", () => {
    window.location.hash = "#verification";
    render(<LegacyAnchor />);

    expect(router.replace).toHaveBeenCalledWith(hrefOf("verification"));
    expect(router.push).not.toHaveBeenCalled();
  });
});

describe("search", () => {
  function openWithShortcut() {
    render(
      <DocsShell>
        <DocsHome />
      </DocsShell>,
    );
    act(() => {
      fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    });
    return screen.getByRole("combobox", { name: /search the docs/i });
  }

  it("opens from the keyboard shortcut, focused and ready to type", () => {
    const input = openWithShortcut();
    expect(screen.getByRole("dialog", { name: /search the docs/i })).toHaveAttribute("open");
    expect(input).toHaveFocus();
  });

  it("opens from the bar's search field too", () => {
    render(
      <DocsShell>
        <DocsHome />
      </DocsShell>,
    );
    fireEvent.click(
      within(screen.getByRole("banner")).getByRole("button", { name: /search docs…/i }),
    );
    expect(screen.getByRole("combobox", { name: /search the docs/i })).toBeInTheDocument();
  });

  it("moves through results with the arrows and opens one with Enter", () => {
    const input = openWithShortcut();
    fireEvent.change(input, { target: { value: "repair" } });

    const options = screen.getAllByRole("option");
    expect(options.length).toBeGreaterThan(1);
    expect(input).toHaveAttribute("aria-activedescendant", options[0]?.id);
    expect(options[0]).toHaveAttribute("aria-selected", "true");

    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input).toHaveAttribute("aria-activedescendant", options[1]?.id);
    fireEvent.keyDown(input, { key: "ArrowUp" });
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(input).toHaveAttribute("aria-activedescendant", options.at(-1)?.id);

    fireEvent.keyDown(input, { key: "Enter" });
    expect(router.push).toHaveBeenCalledWith(options.at(-1)?.getAttribute("href"));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("says so when nothing matches", () => {
    const input = openWithShortcut();
    fireEvent.change(input, { target: { value: "zzzqqq" } });
    expect(screen.queryAllByRole("option")).toEqual([]);
    expect(screen.getByText(/no results for/i)).toBeInTheDocument();
  });
});

describe("the recording", () => {
  // The only assets the docs load, and the only references in them a compiler cannot follow:
  // `src` and `poster` are plain strings resolved by the browser against `apps/web/public`.
  // Rename or forget to commit either and every test above still passes while the page serves
  // a dead player — so this reaches for the filesystem.
  const assetExists = (path: string | null) => existsSync(join(webDir, "public", path ?? ""));

  it("points at files that are actually in the deployed bundle, on its page and the home", () => {
    const { container } = renderPage("how-nap-works");
    const video = container.querySelector("video");
    expect(video).not.toBeNull();
    for (const attribute of ["src", "poster"] as const) {
      expect(assetExists(video?.getAttribute(attribute) ?? null)).toBe(true);
    }

    const home = within(render(<DocsHome />).container);
    fireEvent.click(home.getByRole("button", { name: /play: a recorded nap session/i }));
    const played = home.getByLabelText(/^a recorded nap session/i, { selector: "video" });
    expect(assetExists(played.getAttribute("src"))).toBe(true);
    expect(assetExists(played.getAttribute("poster"))).toBe(true);
  });

  it("does not start playing on its own on the page that explains it", () => {
    renderPage("how-nap-works");
    const figure = screen.getByRole("figure", { name: /recorded nap session/i });

    expect(within(figure).getByLabelText(/recorded nap session/i)).not.toHaveAttribute("autoplay");
  });
});

describe("the docs' colours", () => {
  it("come from the landing page's tokens, never a literal", () => {
    // The point of the theme is that it is the landing page's. A hex value written here would be a
    // colour the landing page can change without this following.
    const dir = join(webDir, "src/docs");
    const files = readdirSync(dir).filter(
      (file) => /\.(tsx?|css)$/.test(file) && !/\.test\.tsx?$/.test(file),
    );
    const offenders = files.flatMap((file) =>
      [
        ...readFileSync(join(dir, file), "utf8").matchAll(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/g),
      ].map(([match]) => `${file}: ${match}`),
    );
    expect(files.length).toBeGreaterThan(10);
    expect(offenders).toEqual([]);
  });
});
