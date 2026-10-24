"use client";

import { useEffect, useRef } from "react";

const follow = (href: string) => window.location.assign(href);

/**
 * How long a link waits on the draft before giving up and saying so. An IndexedDB write takes
 * milliseconds; one that has not finished by now is stuck, and an unbounded wait cancels every
 * later click with nothing on screen to explain why the link did nothing.
 */
export const SAVE_DEADLINE_MS = 3000;

function withinDeadline(work: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Draft save timed out.")), SAVE_DEADLINE_MS);
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

/** A document navigation must wait for IndexedDB; unload cannot finish an async save. */
export function useDraftNavigation(
  save: (() => Promise<void>) | undefined,
  onError: () => void,
  navigate: (href: string) => void = follow,
) {
  const latest = useRef({ save, onError, navigate });
  latest.current = { save, onError, navigate };
  useEffect(() => {
    let active = true;
    let leaving = false;
    const click = (event: MouseEvent) => {
      const save = latest.current.save;
      if (
        !save ||
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey ||
        !(event.target instanceof Element)
      )
        return;
      const anchor = event.target.closest("a[href]");
      if (
        !(anchor instanceof HTMLAnchorElement) ||
        anchor.hasAttribute("download") ||
        (anchor.target && anchor.target !== "_self")
      )
        return;
      const destination = new URL(anchor.href, window.location.href);
      if (
        destination.origin !== window.location.origin ||
        !["http:", "https:"].includes(destination.protocol) ||
        (destination.pathname === window.location.pathname &&
          destination.search === window.location.search &&
          destination.hash)
      )
        return;
      event.preventDefault();
      if (leaving) return;
      leaving = true;
      void withinDeadline(save()).then(
        () => {
          if (active) latest.current.navigate(destination.href);
        },
        () => {
          leaving = false;
          if (active) latest.current.onError();
        },
      );
    };
    document.addEventListener("click", click);
    return () => {
      active = false;
      document.removeEventListener("click", click);
    };
  }, []);
}
