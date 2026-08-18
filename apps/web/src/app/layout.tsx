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

/**
 * The origin social crawlers resolve `opengraph-image.png` against — the deployed site, per
 * `docs/DEPLOY.md`.
 *
 * It has to be absolute and it has to be public: X, LinkedIn and Slack fetch the image from
 * their own servers, so a relative URL resolves against nothing they can reach. Next builds one
 * from `metadataBase`, and *without* it falls back to `localhost:3000` with only a build-time
 * warning — a card that renders with no picture and nothing failing anywhere. It is written out
 * rather than read from a Vercel system variable for that reason: the failure is silent, so the
 * value should not depend on an environment being set up the way we remember.
 */
const siteUrl = "https://nap-tawny.vercel.app";

// Says the same thing as the hero, in the register a search result needs: the joke is the
// page's, and a snippet has to survive being read with no page around it.
const description = "Describe an app and go take a nap. Nap writes the code in a live sandbox.";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: "nap",
  description,
  // The image itself is the `opengraph-image.png` / `twitter-image.png` beside this file: Next
  // reads them off disk at build time and emits the URL, type and pixel dimensions itself. Only
  // the text around it is stated here — `title` is repeated because a card falls back to the tab
  // title otherwise, which is the bare word and reads as a mistake.
  openGraph: {
    type: "website",
    siteName: "nap",
    title: "nap — describe an app, then go take a nap",
    description,
    url: siteUrl,
  },
  // `summary_large_image` is what makes X render the picture full-width rather than as a
  // thumbnail the size of a favicon. It is not inferred from having an image.
  twitter: {
    card: "summary_large_image",
    title: "nap — describe an app, then go take a nap",
    description,
  },
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
