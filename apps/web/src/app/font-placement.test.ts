import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Where the web app's fonts are loaded decides which pages pay for them, and neither mistake
 * this guards against shows up anywhere else.
 *
 * Next preloads a `next/font` face on every route under the layout that calls it. A face added
 * back to the root layout with its preload on is downloaded by every page of the app, and the
 * build, the tests and the page itself all stay green. And the landing page's faces are loaded
 * only by the `(landing)` route group, so a page outside it that draws a landing class gets
 * `sans-serif` and Georgia instead, and a page inside it that draws none still preloads both
 * faces — again with nothing failing.
 *
 * A page "draws" a class when a module it reaches through relative imports names it in a string.
 * That over-reaches, which is the safe direction for the pages outside the group: a class
 * imported but never rendered is reported, never missed.
 *
 * Read from source because the alternative is a production build and a server: what Next
 * actually preloads per route was measured that way when the faces moved, and is in
 * `docs/GOTCHAS.md`.
 */

const APP = dirname(new URL(import.meta.url).pathname);
const SRC = resolve(APP, "..");
const LANDING_GROUP = join(APP, "(landing)");
// The stylesheets that set text in the landing faces. Each reads a variable only the group's
// layout defines.
const LANDING_STYLESHEETS = ["landing/landing.css", "landing/product-story.css"];
const LANDING_FACE_VARIABLES = /var\(--font-(?:inter|newsreader)\)/;

function filesUnder(dir: string, name: (file: string) => boolean): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return filesUnder(path, name);
    return name(entry.name) ? [path] : [];
  });
}

/** The classes whose own rule sets text in a landing face — the roots the faces hang from. */
function classesDrawingLandingFaces(css: string): string[] {
  const uncommented = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const classes = new Set<string>();
  for (const [, selector = "", body = ""] of uncommented.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!LANDING_FACE_VARIABLES.test(body)) continue;
    for (const [, name = ""] of selector.matchAll(/\.([\w-]+)/g)) classes.add(name);
  }
  return [...classes];
}

/** Every module a file reaches through relative imports, itself included. */
function reachable(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [entry];
  for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
    if (seen.has(file)) continue;
    seen.add(file);
    if (!/\.tsx?$/.test(file)) continue;
    const source = readFileSync(file, "utf8");
    for (const [, specifier = ""] of source.matchAll(/(?:from|import)\s*\(?\s*"(\.[^"]+)"/g)) {
      const target = resolve(dirname(file), specifier);
      if (existsSync(target)) queue.push(target);
    }
  }
  return seen;
}

/**
 * The modules that put one of `classes` on an element: the class as a whole word inside a string
 * or template literal. Comments are dropped first, because "the landing page" is prose there.
 */
function drawing(files: Iterable<string>, classes: string[]): string[] {
  // Bounded the way a class list bounds it, so neither prose nor a path such as
  // `../landing/site-header.tsx` counts.
  const token = new RegExp(`(?<=^.|\\s)(?:${classes.join("|")})(?=\\s|.$)`);
  const literals = /"[^"\n]*"|'[^'\n]*'|`[^`]*`/g;
  return [...files].filter((file) => {
    if (!/\.tsx$/.test(file) || file.endsWith(".test.tsx")) return false;
    const code = readFileSync(file, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|\s)\/\/[^\n]*/g, "$1");
    return [...code.matchAll(literals)].some(([literal]) => token.test(literal));
  });
}

describe("font placement", () => {
  const classes = LANDING_STYLESHEETS.flatMap((sheet) =>
    classesDrawingLandingFaces(readFileSync(join(SRC, sheet), "utf8")),
  );
  const pages = filesUnder(APP, (name) => name === "page.tsx");
  const inGroup = (page: string) => page.startsWith(`${LANDING_GROUP}/`);

  it("loads no face in the root layout that every route would preload", () => {
    const layout = readFileSync(join(APP, "layout.tsx"), "utf8");
    const loaders = [
      ...(layout.match(/import\s*\{([^}]*)\}\s*from\s*"next\/font\/google"/)?.[1] ?? "").matchAll(
        /\w+/g,
      ),
    ].map(([name]) => name);
    expect(loaders.length).toBeGreaterThan(0);

    for (const loader of loaders) {
      const call = layout.match(new RegExp(`\\b${loader}\\(\\{([\\s\\S]*?)\\}\\)`))?.[1];
      expect(call, `${loader} is imported but never called`).toBeDefined();
      expect(call, `${loader} in the root layout must not be preloaded`).toMatch(
        /\bpreload:\s*false\b/,
      );
    }
  });

  it("knows which classes draw the landing faces", () => {
    // If this list ever comes back empty, the test after it passes on everything.
    expect(classes).toEqual(expect.arrayContaining(["landing", "lp-serif", "ps-ledger"]));
  });

  it("draws the landing faces on no page outside the group that loads them", () => {
    const outside = pages.filter((page) => !inGroup(page));
    expect(outside.length).toBeGreaterThan(0);
    const strays = outside.flatMap((page) =>
      drawing(reachable(page), classes).map(
        (file) => `${relative(SRC, page)} reaches ${relative(SRC, file)}`,
      ),
    );
    expect(strays).toEqual([]);
  });

  it("puts no page in that group that draws neither face", () => {
    const inside = pages.filter(inGroup);
    expect(inside.length).toBeGreaterThan(0);
    const idle = inside.filter((page) => drawing(reachable(page), classes).length === 0);
    expect(idle.map((page) => relative(SRC, page))).toEqual([]);
  });
});
