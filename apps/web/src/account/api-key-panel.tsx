"use client";

/**
 * The key form, over whatever you were doing.
 *
 * A dialog rather than a page because every route that opens it — the rail, a refused turn,
 * the picker — is somewhere the person meant to be, and sending them away to paste a key means
 * finding their way back afterwards.
 *
 * **A real `<dialog>`, opened with `showModal`.** The browser then owns the parts that are
 * tedious and easy to get subtly wrong: focus moves inside and is trapped there, Escape
 * closes, and everything behind it is inert to a screen reader as well as to a mouse. A `div`
 * with `role="dialog"` looks identical and has none of that.
 */

import { useEffect, useRef } from "react";
import { ApiKeyForm } from "./api-key-form.tsx";
import type { useApiKey } from "./use-api-key.ts";

export function ApiKeyPanel({
  open,
  onClose,
  /** The shared state, so this panel and the rail's label cannot disagree. */
  keyState,
}: {
  open: boolean;
  onClose: () => void;
  keyState: ReturnType<typeof useApiKey>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const element = dialog.current;
    if (element === null) return;

    // `showModal` rather than the `open` attribute: the attribute renders the dialog without
    // any of the modal behaviour — no focus trap, no Escape, no inert backdrop.
    if (open && !element.open) element.showModal();
    if (!open && element.open) element.close();
  }, [open]);

  return (
    <dialog
      ref={dialog}
      aria-label="Your API key"
      /*
       * Clicking the backdrop closes it, natively.
       *
       * The hand-written version of this is a click handler on the dialog that compares
       * `event.target` to the element — which works, and is a mouse-only path that a
       * keyboard user has no equivalent for. `closedby` is the browser's own answer and it
       * covers Escape by the same mechanism. Lower-cased because React passes attributes it
       * does not recognise straight through; a browser that has not implemented it simply
       * keeps Escape and the ✕, which are the two that matter.
       */
      closedby="any"
      // Escape, the backdrop and `close()` all arrive here.
      onClose={onClose}
      className="m-auto w-full max-w-sm rounded-[20px] border border-[var(--s-border-1)] bg-[var(--s-surface-1)] p-6 text-[var(--s-text-primary)] backdrop:bg-black/40"
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="font-semibold text-base">Your API key</h2>
          <p className="mt-1 text-[var(--s-text-muted)] text-sm">
            Unlocks Claude Opus and the paid GPT models. Free models work without one.
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="shrink-0 rounded-full px-2 py-1 text-[var(--s-text-muted)] hover:text-[var(--s-text-primary)] focus-visible:outline focus-visible:outline-1 focus-visible:outline-[var(--s-text-primary)]"
        >
          ✕
        </button>
      </div>

      <div className="mt-5">
        <ApiKeyForm
          state={keyState.state ?? { configured: false }}
          onSave={(apiKey) => void keyState.save(apiKey)}
          onRemove={() => void keyState.remove()}
          error={keyState.error}
          busy={keyState.busy}
        />
      </div>
    </dialog>
  );
}
