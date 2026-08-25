import * as DialogPrimitive from "@radix-ui/react-dialog";
import { XIcon } from "lucide-react";
import type * as React from "react";
import { cn } from "@/lib/utils";

/**
 * The primitive most worth not hand-rolling.
 *
 * A modal built from a `<div>` and a `useState` gets the visuals right and everything else
 * wrong: focus stays behind the overlay, Escape does nothing, the page underneath keeps
 * scrolling, and a screen reader never learns a dialog opened. Radix handles the focus trap,
 * the `aria-modal` wiring and the scroll lock; what is vendored here is only the styling.
 *
 * `DialogTitle` is required by Radix, not optional — a dialog without one warns in the console
 * and is unlabelled to assistive technology. If a design has no visible title, wrap one in
 * `<VisuallyHidden>` rather than dropping it.
 */
export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;
export const DialogPortal = DialogPrimitive.Portal;

export function DialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      // No enter/exit animation: that needs an animation plugin, and a `data-[state=open]`
      // class with nothing behind it compiles to nothing and reads like it works.
      className={cn("fixed inset-0 z-50 bg-ink/40 backdrop-blur-[2px]", className)}
      {...props}
    />
  );
}

export function DialogContent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content>) {
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        className={cn(
          "fixed top-1/2 left-1/2 z-50 w-full max-w-lg -translate-x-1/2 -translate-y-1/2",
          "rounded-xl border border-border bg-surface p-6 shadow-overlay",
          className,
        )}
        {...props}
      >
        {children}
        <DialogPrimitive.Close
          className="absolute top-4 right-4 rounded-sm p-1 text-ink-subtle transition-colors hover:bg-surface-muted hover:text-ink"
          // The icon is the whole control, so the name has to come from somewhere else.
          aria-label="Close"
        >
          <XIcon className="size-4" aria-hidden="true" />
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPortal>
  );
}

export function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("flex flex-col gap-1.5 pr-8 pb-4", className)} {...props} />;
}

export function DialogFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("flex flex-col-reverse gap-3 pt-6 sm:flex-row sm:justify-end", className)}
      {...props}
    />
  );
}

export function DialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title className={cn("text-xl font-semibold text-ink", className)} {...props} />
  );
}

export function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description className={cn("text-sm text-ink-muted", className)} {...props} />
  );
}
