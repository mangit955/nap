import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

/**
 * Visitor counts and Core Web Vitals reach Vercel's dashboard only while the root layout renders
 * `<Analytics />` and `<SpeedInsights />`. Losing either fails nothing: every page still renders,
 * and the dashboard simply stops counting.
 *
 * Both must come from the packages' `/next` entry points, which read Next's router to report the
 * route template (`/docs`, `/p/[projectId]`) beside the path. The plain React ones report the path
 * alone.
 *
 * The real components render nothing on the server and inject their scripts after hydration, so
 * the layout is rendered here with each `/next` entry point standing in as a marker. A component
 * imported from anywhere else, commented out or deleted leaves its marker out of the markup. What
 * a browser loads was checked with a production build in headless Chrome.
 */

vi.mock("@vercel/analytics/next", () => ({ Analytics: () => <i data-mounted="analytics" /> }));
vi.mock("@vercel/speed-insights/next", () => ({
  SpeedInsights: () => <i data-mounted="speed-insights" />,
}));
vi.mock("next/font/google", () => ({ Bricolage_Grotesque: () => ({ variable: "font-display" }) }));

describe("the root layout", () => {
  it.each(["analytics", "speed-insights"])("mounts %s from its /next entry point", async (name) => {
    const { default: RootLayout } = await import("./layout");
    const html = renderToStaticMarkup(<RootLayout>page</RootLayout>);
    expect(html).toContain(`data-mounted="${name}"`);
  });
});
