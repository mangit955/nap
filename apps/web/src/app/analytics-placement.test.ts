import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Visitor counts and Core Web Vitals reach Vercel's dashboard only while the root layout renders
 * `<Analytics />` and `<SpeedInsights />`. Losing either fails nothing: every page still renders,
 * and the dashboard simply stops counting. So this reads the layout's source.
 *
 * Both must come from the packages' `/next` entry points. Those read Next's router and report the
 * route template beside the path (`/p/[projectId]`), so the dashboard groups every project's
 * workspace as one page instead of listing each project id as a page of its own.
 *
 * Read from source because the scripts are injected on the client after hydration, so the HTML a
 * server returns never shows them. What a browser loads was checked with a production build in
 * headless Chrome: `/_vercel/insights/script.js` and `/_vercel/speed-insights/script.js` on every
 * route.
 */

const LAYOUT = join(dirname(new URL(import.meta.url).pathname), "layout.tsx");
const source = readFileSync(LAYOUT, "utf8");

describe("the root layout", () => {
  it.each([
    ["Analytics", "@vercel/analytics/next"],
    ["SpeedInsights", "@vercel/speed-insights/next"],
  ])("renders <%s /> from %s", (component, entry) => {
    expect(source).toMatch(new RegExp(`import \\{ ${component} \\} from "${entry}";`));
    expect(source).toMatch(new RegExp(`<${component}\\b[^>]*/>`));
  });
});
