import * as LabelPrimitive from "@radix-ui/react-label";
import type * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Radix rather than a bare `<label>` so that clicking the text focuses the control even when
 * the two are not nested — which is the arrangement most form layouts end up in.
 */
export function Label({ className, ...props }: React.ComponentProps<typeof LabelPrimitive.Root>) {
  return (
    <LabelPrimitive.Root
      className={cn("text-sm font-medium text-ink select-none peer-disabled:opacity-60", className)}
      {...props}
    />
  );
}
