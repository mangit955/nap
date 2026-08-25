import type * as React from "react";
import { cn } from "@/lib/utils";

/**
 * A text input with a border a person can actually see.
 *
 * The hairline borders most generated forms use fail the 3:1 contrast a control boundary
 * needs, so this uses `border-strong` — the token that exists for exactly this.
 *
 * `Textarea` and `SelectTrigger` repeat these classes rather than sharing them, and that is
 * the point of copy-in components: the brief tells the agent to edit these files, and a
 * shared `fieldVariants` would mean restyling the input silently restyled the select too.
 * The tokens are the shared thing; the class lists are not.
 */
export function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      className={cn(
        "flex h-10 w-full rounded-md border border-border-strong bg-surface px-3 py-2 text-sm text-ink transition-colors",
        "placeholder:text-ink-subtle",
        "hover:border-ink-subtle",
        "disabled:cursor-not-allowed disabled:bg-surface-muted disabled:opacity-60",
        "aria-invalid:border-danger",
        "file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-ink",
        className,
      )}
      {...props}
    />
  );
}
