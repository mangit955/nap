import { Inter, Newsreader } from "next/font/google";
import type { ReactNode } from "react";

/**
 * The front page's two faces: a light serif for its headings and Inter for everything else on it.
 *
 * The serif is what makes the page read as editorial rather than as another dashboard — the same
 * choice the design it follows makes — and it is loaded across its optical-size axis because the
 * headings are set at display sizes, where the high-`opsz` cut is the one drawn for them.
 *
 * **Loaded here, not in the root layout, because Next preloads a font on every route under the
 * layout that calls it.** In the root they cost every page of the app about 180KB of woff2 it never
 * draws. This group holds exactly the documents that draw them: `/`, and the two `/demo/*` apps
 * the landing page shows in iframes — the ledger and the booking site — which are documents of
 * their own and read the same variables from `landing.css` and `product-story.css`. The other two
 * demos draw neither face and sit outside it. A page outside the group that draws a landing class
 * gets `sans-serif` and Georgia without any error, and one inside it that draws none preloads
 * 180KB for nothing; `font-placement.test.ts` fails on both.
 */
const landingSerif = Newsreader({
  subsets: ["latin"],
  variable: "--font-newsreader",
  axes: ["opsz"],
  display: "swap",
});

const landingSans = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

export default function LandingLayout({ children }: { children: ReactNode }) {
  // `contents` generates no box, so the pages lay out exactly as they did as children of `body`.
  // The variables still inherit through it, because inheritance follows the DOM tree, not boxes.
  return (
    <div className={`${landingSerif.variable} ${landingSans.variable} contents`}>{children}</div>
  );
}
