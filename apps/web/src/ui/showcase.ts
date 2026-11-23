"use client";

import { createContext } from "react";

/**
 * The product drawn as a still picture of itself, which is what the landing page's demos are.
 *
 * The demos render the real components with sample data, so a visitor sees the product rather
 * than a drawing of it. A few things that serve someone *using* the product are noise in a
 * picture nobody can use. Each field here turns one of them off. The product never provides this
 * context, so it always gets `null` and every component behaves as it does without it.
 *
 * It is a context and not props because the parts it reaches sit three or four components below
 * anything the landing page renders: a step row inside a transcript, a repository mark inside a
 * sidebar row. Threading a prop through each layer between them would change every signature on
 * the way for a caller that is not the product.
 */
export type Showcase = {
  /**
   * The newest message fading its words in as they stream. A picture has nothing still arriving,
   * and on it the fade reads as text being typed out.
   */
  streamingText: boolean;
  /** "Copy response" on each agent message. There is nothing to paste it into. */
  copyButtons: boolean;
  /** The vendor's mark beside the model's name in the composer. Its brand colour is not Nap's. */
  vendorLogos: boolean;
  /** A failed command opens with its output showing, since nobody can click it open. */
  openFailedSteps: boolean;
  /**
   * Repository owners' avatars from github.com. The demos' owners are made up, so a real account
   * of that name would put a stranger's picture on the page. A letter mark is drawn instead.
   */
  remoteAvatars: boolean;
  /**
   * The sidebar scrolling its selected row into view. `scrollIntoView` moves every scrolling
   * ancestor, and on the landing page that is the page itself, pulled down under a reader.
   */
  revealSelection: boolean;
  /** Which tab a pull request opens on. */
  pullRequestView: "Summary" | "Timeline" | "Code" | "Settings";
};

export const SHOWCASE: Showcase = {
  streamingText: false,
  copyButtons: false,
  vendorLogos: false,
  openFailedSteps: true,
  remoteAvatars: false,
  revealSelection: false,
  pullRequestView: "Summary",
};

export const ShowcaseContext = createContext<Showcase | null>(null);
