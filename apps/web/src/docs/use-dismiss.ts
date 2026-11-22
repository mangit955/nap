"use client";

/**
 * Escape closes a disclosure — the phone menu, the phone's "On this page" — and puts focus back on
 * the button that opened it, so a keyboard reader is not left on the page's `body`.
 *
 * Not while a dialog is open; the only one here is search, which is always modal. Search can be
 * opened from inside the menu, and the dialog closes itself on the same Escape, which reaches this
 * listener while the dialog is still open. If the menu closed too, the field the dialog returns
 * focus to would already be gone.
 */

import { type RefObject, useEffect } from "react";

export function useDismiss(
  open: boolean,
  close: () => void,
  opener: RefObject<HTMLElement | null>,
) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || document.querySelector("dialog[open]")) return;
      // A disclosure under the open phone menu — the page's "On this page" list — is covered and
      // inert; the menu on top is what this Escape is for.
      if (opener.current?.closest("[inert]")) return;
      close();
      opener.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close, opener]);
}
