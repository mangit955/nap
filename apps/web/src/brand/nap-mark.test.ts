import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The mark exists twice — once as a component and once as the file the browser uses for a tab
 * icon — and there is no way to make the second import the first: a favicon is a static asset
 * the framework serves, not a module it renders.
 *
 * So the two are pinned to each other here. Drift between them is invisible in every ordinary
 * way of looking at this app: the header would be right, the tests would pass, and only the
 * favicon would be wrong, which is the one surface nobody screenshots.
 */
const component = readFileSync(new URL("./nap-mark.tsx", import.meta.url), "utf8");
const icon = readFileSync(new URL("../app/icon.svg", import.meta.url), "utf8");

/** The `d` of the first path in a file. */
function outline(source: string): string {
  const match = /\sd="([^"]+)"/.exec(source);
  if (match?.[1] === undefined) throw new Error("no path found");
  return match[1].replace(/\s+/g, " ").trim();
}

describe("the mark", () => {
  it("is the same drawing in the component and the favicon", () => {
    expect(outline(icon)).toBe(outline(component));
  });

  it("knocks its eyes out of the fill rather than drawing over it", () => {
    // One path, one colour, `evenodd`. Eyes painted in the background colour instead would
    // look identical here and break the moment the surface behind the mark changed — which it
    // does, since the same mark sits on the light stage and in the dark workspace header.
    for (const source of [component, icon]) {
      expect(source).toMatch(/fill-?[rR]ule="?\{?"?evenodd/);
    }
  });

  it("takes its colour from the text around it", () => {
    // The component only. The favicon is a standalone file with nothing to inherit from, which
    // is exactly why it is allowed its own literal colours.
    expect(component).toContain('fill="currentColor"');
  });

  it("sets no size of its own", () => {
    // It has to be a 16px tab icon and a 24px sign-in mark from one file, so the caller sizes
    // it. A width baked in here would be overridden in three places and forgotten in a fourth.
    expect(component).not.toMatch(/\swidth="\d/);
    expect(component).not.toMatch(/\sheight="\d/);
  });
});
