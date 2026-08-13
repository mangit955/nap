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
import { CloseIcon } from "../ui/icons.tsx";
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
      /*
       * `ai-stage-dark` is what makes the shared form legible here.
       *
       * `ApiKeyForm` paints itself in the `--s-*` ramp, which is scoped to `.ai-stage` — the
       * light pages. Over the workspace those variables resolve to nothing, which is not an
       * error and not a fallback: it is a dialog with no fill, no border and the page showing
       * through its text. The class hands the same names a dark set of values. See `globals.css`.
       *
       * The rest is depth. A modal over a near-black frame cannot separate itself with a
       * hairline alone, so it is a raised panel over a dimmed, blurred room: a long shadow for
       * the lift, and one inset highlight along the top edge, which is how a real surface catches
       * the light and the cheapest thing that stops a flat rectangle reading as a cutout.
       */
      className="nap-dialog ai-stage-dark m-auto w-full max-w-md rounded-[20px] border border-edge bg-panel p-7 text-ink shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_32px_64px_-16px_rgba(0,0,0,0.75)] backdrop:bg-black/60 backdrop:backdrop-blur-[3px]"
    >
      <div className="flex items-start justify-between gap-5">
        <div>
          <h2 className="font-semibold text-[15px] text-ink tracking-tight">Your API key</h2>
          {/*
            The offer, not a requirement — whoever is reading this already has a working app on
            the free models. `text-pretty` keeps the second line from falling to one short word.
          */}
          <p className="mt-1.5 text-pretty text-[13px] text-muted leading-relaxed">
            Unlocks Claude Opus and the paid GPT models. Free models work without one.
          </p>
        </div>
        {/*
          A drawn ✕ rather than the character. The glyph is a different weight, size and
          baseline in every font a browser might reach for, so it never quite sat on the centre
          of its own button; this one is on the same 16px grid as every other icon in the app.
          The well appears on hover rather than sitting there, because dismissing is not the
          thing anybody opened this to do.
        */}
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="-mr-1.5 -mt-1.5 flex size-8 shrink-0 items-center justify-center rounded-full text-muted transition-colors hover:bg-hover hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          <CloseIcon className="size-4" />
        </button>
      </div>

      {/* A full-bleed rule, so the head reads as a head rather than as the first paragraph. */}
      <div aria-hidden="true" className="-mx-7 mt-5 h-px bg-edge" />

      <div className="mt-6">
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
