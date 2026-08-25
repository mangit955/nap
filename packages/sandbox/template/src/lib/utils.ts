import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Joins class names and lets a later one win over an earlier conflict.
 *
 * Without the merge, `cn("px-4", props.className)` with `className="px-6"` emits both and the
 * winner depends on stylesheet order rather than on the caller — which is why every component
 * here takes `className` last and passes it through this.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
