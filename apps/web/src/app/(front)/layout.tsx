import { Doto, Geist, Geist_Mono, Silkscreen } from "next/font/google";
import type { ReactNode } from "react";

/**
 * The front page's faces, and only the front page's: Doto, a dot-matrix display face, for the
 * headings; Geist Mono for the text and every label; Geist for the few titles set in a sans; and
 * Silkscreen for the pixel badge.
 *
 * **The text is monospaced on purpose.** The page is drawn as a terminal-and-ledger, and a
 * proportional body face beside dot-matrix headings and bracketed mono buttons read as two
 * designs. Geist Mono was chosen over the alternatives because it is drawn as a sibling of
 * Geist, so the few sans titles sit with it, and because its wide, open shapes stay readable at
 * 14–16px, where most monospaced faces drawn for code begin to look cramped.
 *
 * **A group of its own, because Next preloads a face on every route under the layout that calls
 * it.** The rest of `(landing)` (the docs, sign-in, sign-up) still draws Newsreader and Inter, and
 * would pay for these faces without drawing them. `font-placement.test.ts` fails if a page here
 * draws no Num1 face, or a page outside reaches one.
 */
const dot = Doto({
  subsets: ["latin"],
  weight: ["900"],
  variable: "--font-doto",
  display: "swap",
});

const mono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-geist-mono",
  display: "swap",
});

// Below the first screen on a phone and drawn small everywhere, so it is not worth a preload.
const sans = Geist({
  subsets: ["latin"],
  variable: "--font-geist",
  display: "swap",
  preload: false,
});

const pixel = Silkscreen({
  subsets: ["latin"],
  weight: ["400"],
  variable: "--font-silkscreen",
  display: "swap",
  preload: false,
});

export default function FrontLayout({ children }: { children: ReactNode }) {
  // `contents` generates no box; the variables still inherit, because inheritance follows the DOM.
  return (
    <div className={`${dot.variable} ${mono.variable} ${sans.variable} ${pixel.variable} contents`}>
      {children}
    </div>
  );
}
