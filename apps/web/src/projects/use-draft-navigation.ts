"use client";

import { useEffect, useRef } from "react";

const follow = (href: string) => window.location.assign(href);

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
      void save().then(
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
