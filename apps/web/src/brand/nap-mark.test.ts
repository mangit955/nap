import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { NAP_BODY, NAP_EYE_SHUT_LEFT, NAP_EYE_SHUT_RIGHT } from "./nap-mark-paths.ts";

/**
 * The mark is drawn twice — once as a component and once as the file the browser uses for a tab
 * icon — and there is no way to make the second import the first: a favicon is a static asset
 * the framework serves, not a module it renders.
 *
 * So the favicon is pinned to the shared geometry here. Drift is invisible in every ordinary
 * way of looking at this app: the header would be right, every other test would pass, and only
 * the tab icon would be wrong, which is the one surface nobody screenshots.
 */
const component = readFileSync(new URL("./nap-mark.tsx", import.meta.url), "utf8");
const icon = readFileSync(new URL("../app/icon.svg", import.meta.url), "utf8");

describe("the favicon", () => {
  it("is drawn from the same geometry as the component", () => {
    expect(icon).toContain(NAP_BODY);
    expect(icon).toContain(NAP_EYE_SHUT_LEFT);
    expect(icon).toContain(NAP_EYE_SHUT_RIGHT);
  });

  it("is asleep", () => {
    // The awake face belongs to a hover, and nothing hovers a tab icon. A favicon drawn with
    // its eyes open would also be the one place the mark contradicts the product's name.
    expect(icon).not.toContain("<ellipse");
  });

  it("names itself, being a document of its own", () => {
    expect(icon).toContain("<title>nap</title>");
  });
});

describe("the component", () => {
  it("cuts the eyes out with a mask rather than painting over them", () => {
    // The mask is what keeps the mark a single colour — it sits on a light stage and in a dark
    // header — and it is also what lets the eyes move while the body holds still. Eyes filled
    // in the background colour would look identical and break on both counts.
    expect(component).toContain("<mask");
    // A pattern rather than the literal source, which would both break on reformatting and read
    // to the linter as a template placeholder somebody forgot to interpolate.
    expect(component).toMatch(/mask=\{[^}]*maskId/);
  });

  it("gives every instance its own mask id", () => {
    // Two marks on one page sharing an id means the second silently uses the first one's
    // cut-outs — which renders as a ghost with no eyes at all.
    expect(component).toContain("useId()");
  });

  it("takes its colour from the text around it", () => {
    expect(component).toContain('fill="currentColor"');
  });

  it("sets no size of its own", () => {
    // It has to be a 16px tab icon and a 24px header mark from one file, so the caller sizes
    // it. A width baked in here would be overridden in three places and forgotten in a fourth.
    //
    // Scoped to the opening tag rather than the whole file, because the mask legitimately
    // contains a sized rect — the first version of this asserted over the file and failed the
    // moment the eyes needed cutting out, which is a test measuring the wrong thing.
    const root = /<svg\b[^>]*>/.exec(component)?.[0] ?? "";
    expect(root).not.toBe("");
    expect(root).not.toMatch(/\swidth=/);
    expect(root).not.toMatch(/\sheight=/);
  });
});
