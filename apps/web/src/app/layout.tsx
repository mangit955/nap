import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

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
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
