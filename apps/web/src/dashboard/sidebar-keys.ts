/**
 * The sidebar's keyboard shortcuts, as T3 binds them: the platform modifier and a digit jumps
 * to that row, mod+shift+] and [ step to the next and previous session, and holding the modifier
 * on its own shows which digit goes where. Brackets are matched by `code`, the physical key,
 * because with Shift held most layouts print `}` and `{` instead.
 *
 * Adapted from T3 Code (MIT, Copyright (c) 2026 T3 Tools Inc.), `packages/shared/src/keybindings.ts`.
 */

type Keys = Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">;

export type ShortcutCommand = { kind: "jump"; index: number } | { kind: "step"; direction: 1 | -1 };

/** Mac's Command, everyone else's Control. */
export function isMacPlatform(): boolean {
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
}

function modifier(event: Keys, mac: boolean): boolean {
  return mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}

export function shortcutCommand(event: Keys, mac: boolean): ShortcutCommand | null {
  if (!modifier(event, mac) || event.altKey) return null;
  if (event.shiftKey) {
    if (event.code === "BracketRight") return { kind: "step", direction: 1 };
    if (event.code === "BracketLeft") return { kind: "step", direction: -1 };
    return null;
  }
  const digit = /^[1-9]$/.test(event.key) ? Number(event.key) : null;
  return digit === null ? null : { kind: "jump", index: digit - 1 };
}

/** Whether the modifier alone is down — the moment the jump hints are worth showing. */
export function showsJumpHints(event: Keys, mac: boolean): boolean {
  return modifier(event, mac) && !event.shiftKey && !event.altKey;
}

/** The keyboard's ways of asking for a context menu. */
export function opensMenu(event: Pick<Keys, "key" | "shiftKey">): boolean {
  return event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey);
}

/** The id one step from `current`; from an end when nothing is open, nothing past either end. */
export function adjacentId(
  order: readonly string[],
  current: string | undefined,
  direction: 1 | -1,
): string | undefined {
  const index = current === undefined ? -1 : order.indexOf(current);
  if (index < 0) return direction === 1 ? order[0] : order.at(-1);
  return order[index + direction];
}
