"use client";

import type { ReactNode } from "react";
import { revealProps, useReveal } from "./use-reveal.ts";

/**
 * A block that settles into place as it is scrolled to: a short fade and rise, compositor-only
 * (`opacity` and `transform`), so it costs no layout and cannot shift anything around it. The
 * rules for when it hides and never re-hides are `useReveal`'s.
 */
export function Reveal({ className, children }: { className?: string; children: ReactNode }) {
  const { ref, state } = useReveal<HTMLDivElement>();
  const props = revealProps(state);
  return (
    <div
      ref={ref}
      className={className === undefined ? props.className : `${props.className} ${className}`}
      data-reveal={props["data-reveal"]}
    >
      {children}
    </div>
  );
}
