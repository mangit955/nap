import type * as React from "react";
import { cn } from "@/lib/utils";

export function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      className={cn(
        "flex min-h-24 w-full rounded-md border border-border-strong bg-surface px-3 py-2 text-sm text-ink transition-colors",
        "placeholder:text-ink-subtle",
        "hover:border-ink-subtle",
        "disabled:cursor-not-allowed disabled:bg-surface-muted disabled:opacity-60",
        "aria-invalid:border-danger",
        className,
      )}
      {...props}
    />
  );
}
