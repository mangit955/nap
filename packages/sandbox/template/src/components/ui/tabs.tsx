import * as TabsPrimitive from "@radix-ui/react-tabs";
import type * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Underlined rather than the pill-in-a-tray shadcn ships, because tabs usually sit directly
 * above the content they switch — an underline joins them, a tray separates them.
 *
 * Roving focus and arrow-key navigation come from Radix; a set of buttons and a `useState`
 * gets neither, and is the usual hand-rolled version.
 */
export const Tabs = TabsPrimitive.Root;

export function TabsList({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      className={cn("flex items-center gap-6 border-b border-border", className)}
      {...props}
    />
  );
}

export function TabsTrigger({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      className={cn(
        "-mb-px border-b-2 border-transparent px-1 pb-3 text-sm font-medium text-ink-subtle transition-colors",
        "hover:text-ink",
        "data-[state=active]:border-accent data-[state=active]:text-ink",
        "disabled:pointer-events-none disabled:opacity-60",
        className,
      )}
      {...props}
    />
  );
}

export function TabsContent({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return <TabsPrimitive.Content className={cn("pt-6", className)} {...props} />;
}
