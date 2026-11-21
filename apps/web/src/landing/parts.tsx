"use client";

import type { ReactNode } from "react";
import { revealProps, useReveal } from "./use-reveal.ts";

/**
 * Fades its children up as they scroll into view. Starts visible and hides only once an observer
 * exists to bring it back — `useReveal`'s rule — so nothing is lost to a page with no script.
 */
export function Reveal({ children, className = "" }: { children: ReactNode; className?: string }) {
  const { ref, state } = useReveal<HTMLDivElement>();
  const props = revealProps(state);
  return (
    <div ref={ref} {...props} className={`${props.className} ${className}`}>
      {children}
    </div>
  );
}
