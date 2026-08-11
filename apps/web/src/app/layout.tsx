import type { Metadata, Viewport } from "next";
import { Bricolage_Grotesque } from "next/font/google";
import type { ReactNode } from "react";
import "./globals.css";

/**
 * The display face, used on the landing page's headline and nowhere else.
 *
 * A grotesque with deliberately odd details — a wide, low-waisted `a`, a flat-topped `t`, a
 * tail on the `l` — which is exactly what a system stack cannot give a first sentence. It is
 * loaded across its whole weight axis because the treatment *is* the weight: the sentence sits
 * at 200 and one word at 600, and both have to be the same typeface or the contrast reads as a
 * fallback rather than as a choice.
 *
 * The rest of the app keeps the system sans. A builder UI is a frame around somebody else's
 * work, and a characterful face is the opposite of what a frame should be doing.
 */
const display = Bricolage_Grotesque({
  subsets: ["latin"],
  variable: "--font-bricolage",
  display: "swap",
});

export const metadata: Metadata = {
  title: "nap",
  // Says the same thing as the hero, in the register a search result needs: the joke is the
  // page's, and a snippet has to survive being read with no page around it.
  description: "Describe an app and go take a nap. Nap writes the code in a live sandbox.",
};

// `colorScheme: dark` tells the browser to render form controls and scrollbars dark too,
// which is the difference between a dark app and a dark app with white scrollbars.
export const viewport: Viewport = {
  colorScheme: "dark",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={display.variable}>
      <body>{children}</body>
    </html>
  );
}
