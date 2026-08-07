import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "nap",
  description: "Describe an app; watch it get built.",
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
