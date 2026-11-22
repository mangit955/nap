import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { SessionContextMenu } from "./session-context-menu.tsx";
import type { MenuItem } from "./session-menu.ts";

/**
 * Every colour the theme defines, so `text-ink-2` reads as a colour and `text-[13px]` or
 * `text-left` do not. Read from the stylesheet rather than listed here, so a token added there is
 * covered without touching this file.
 */
const THEME_COLOURS = new Set([
  ...[
    ...readFileSync(join(import.meta.dirname, "../app/globals.css"), "utf8").matchAll(
      /--color-([a-z0-9-]+):/g,
    ),
  ].map((match) => match[1]),
  "white",
  "black",
  "transparent",
  "current",
]);

/**
 * The colour utilities in a class list, keyed by the state they apply in (`""` at rest, `hover`,
 * `focus-visible`, …) and the property they set.
 *
 * jsdom has no Tailwind stylesheet, so a computed colour proves nothing here. What can be checked
 * is the cause: two utilities setting one property in one state. Tailwind settles that by where
 * each lands in the generated stylesheet, not by their order in the class list, so the class list
 * that reads as "grey, then red" can draw grey.
 */
function colours(className: string) {
  const found = new Map<string, string[]>();
  for (const token of className.split(/\s+/).filter(Boolean)) {
    const parts = token.split(":");
    const utility = parts.pop() ?? "";
    const state = parts.join(":");
    const match = /^(text|bg)-(.+?)(?:\/\d+)?$/.exec(utility);
    if (!match?.[1] || !match[2] || !THEME_COLOURS.has(match[2])) continue;
    const key = `${state}|${match[1]}`;
    found.set(key, [...(found.get(key) ?? []), match[2]]);
  }
  return found;
}

const ITEMS: MenuItem[] = [
  { id: "rename", label: "Rename" },
  { id: "snooze", label: "Snooze", children: [{ id: "snooze:custom", label: "Custom…" }] },
  { id: "archive", label: "Archive", separatorBefore: true },
  { id: "delete", label: "Delete", destructive: true },
];

function open() {
  render(
    <SessionContextMenu
      label="Seeded notes app"
      items={ITEMS}
      at={{ x: 10, y: 10 }}
      onSelect={vi.fn()}
      onClose={vi.fn()}
    />,
  );
  return screen.getAllByRole("menuitem");
}

it("draws Delete in the danger colour and every other item in grey, one colour per state", () => {
  const conflicts = open().flatMap((item) =>
    [...colours(item.className)]
      .filter(([, values]) => values.length > 1)
      .map(([key, values]) => `${item.textContent} ${key}: ${values.join(" and ")}`),
  );
  expect(conflicts).toEqual([]);
  const textColours = (name: string) =>
    Object.fromEntries(
      [...colours(screen.getByRole("menuitem", { name }).className)]
        .filter(([key]) => key.endsWith("|text"))
        .map(([key, values]) => [key.slice(0, -"|text".length) || "rest", values]),
    );
  // Red in every state that names a colour, so a grey slipped in for hover or focus fails too.
  const deleteColours = textColours("Delete");
  expect(deleteColours.rest).toEqual(["danger"]);
  for (const values of Object.values(deleteColours)) expect(values).toEqual(["danger"]);
  expect(textColours("Archive").rest).toEqual(["ink-2"]);
  // A submenu's owner is drawn by its own branch of the menu, so it is checked on its own.
  expect(textColours("Snooze").rest).toEqual(["ink-2"]);
});

it("outlines only the focused item under forced colours, where the focus wash is painted over", () => {
  for (const item of open()) {
    const classes = item.className.split(/\s+/);
    expect(classes).toContain("focus-visible:outline-hidden");
    // Unprefixed, either one acts on every item: `outline-none` leaves no focus indicator in that
    // mode, and `outline-hidden` outlines every item, focused or not.
    expect(classes).not.toContain("outline-hidden");
    expect(classes).not.toContain("outline-none");
  }
});
