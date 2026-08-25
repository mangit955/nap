import * as SelectPrimitive from "@radix-ui/react-select";
import { CheckIcon, ChevronDownIcon } from "lucide-react";
import type * as React from "react";
import { cn } from "@/lib/utils";

/**
 * A listbox with the keyboard behaviour people expect.
 *
 * The hand-rolled version of this is always a button that toggles an absolutely positioned
 * `<ul>`, and it always has the same four defects: arrow keys do nothing, typing a letter does
 * not jump, clicking outside does not close it, and it is clipped by the first ancestor with
 * `overflow: hidden`. Radix portals the content, manages the active descendant and restores
 * focus to the trigger on close.
 *
 * A native `<select>` is still the right answer for a plain list of short options. Reach for
 * this when the options need markup — an icon, a description, a swatch — or when the trigger
 * has to match the rest of the form.
 */
export const Select = SelectPrimitive.Root;
export const SelectGroup = SelectPrimitive.Group;
export const SelectValue = SelectPrimitive.Value;

export function SelectTrigger({
  className,
  children,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Trigger>) {
  return (
    <SelectPrimitive.Trigger
      className={cn(
        "flex h-10 w-full items-center justify-between gap-2 rounded-md border border-border-strong bg-surface px-3 py-2 text-sm text-ink transition-colors",
        "hover:border-ink-subtle",
        "data-[placeholder]:text-ink-subtle",
        "disabled:cursor-not-allowed disabled:bg-surface-muted disabled:opacity-60",
        className,
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon asChild>
        {/* Directional, not decorative — it is what says this opens. */}
        <ChevronDownIcon className="size-4 shrink-0 text-ink-subtle" aria-hidden="true" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

export function SelectContent({
  className,
  children,
  position = "popper",
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Content>) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        position={position}
        className={cn(
          "relative z-50 max-h-96 min-w-32 overflow-hidden rounded-md border border-border bg-surface shadow-overlay",
          // Matches the trigger's width so the list does not jump narrower than the control.
          position === "popper" && "w-[var(--radix-select-trigger-width)]",
          className,
        )}
        {...props}
      >
        <SelectPrimitive.Viewport className="p-1">{children}</SelectPrimitive.Viewport>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
}

export function SelectLabel({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Label>) {
  return (
    <SelectPrimitive.Label
      className={cn("px-2 py-1.5 text-xs font-medium text-ink-subtle", className)}
      {...props}
    />
  );
}

export function SelectItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Item>) {
  return (
    <SelectPrimitive.Item
      className={cn(
        "relative flex w-full cursor-default items-center gap-2 rounded-sm py-2 pr-8 pl-2 text-sm text-ink outline-hidden select-none",
        "data-highlighted:bg-surface-muted",
        "data-disabled:pointer-events-none data-disabled:opacity-60",
        className,
      )}
      {...props}
    >
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
      <span className="absolute right-2 flex size-4 items-center justify-center">
        <SelectPrimitive.ItemIndicator>
          {/* Decorative: selection is already announced through `aria-selected`. */}
          <CheckIcon className="size-4 text-accent" aria-hidden="true" />
        </SelectPrimitive.ItemIndicator>
      </span>
    </SelectPrimitive.Item>
  );
}

export function SelectSeparator({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Separator>) {
  return (
    <SelectPrimitive.Separator className={cn("-mx-1 my-1 h-px bg-border", className)} {...props} />
  );
}
