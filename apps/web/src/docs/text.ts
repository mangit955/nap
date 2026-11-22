/**
 * Reading words back out of a React tree, so the "On this page" list, the heading ids and the
 * search index are all derived from the prose rather than written beside it.
 *
 * A second hand-kept copy of every subheading would drift from the page the first time one was
 * reworded, and the drift would show up as a dead link or a search hit that scrolls nowhere.
 */

import { isValidElement, type ReactNode } from "react";

/** The text a node renders, with whitespace collapsed the way a browser would lay it out. */
export function textOf(node: ReactNode): string {
  return rawText(node).replace(/\s+/g, " ").trim();
}

function rawText(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(rawText).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) {
    const inner = rawText(node.props.children);
    // A paragraph or list item ends a word even when the markup puts the next one flush
    // against it; an inline element such as `em` does not.
    return typeof node.type === "string" && !INLINE.has(node.type) ? ` ${inner} ` : inner;
  }
  return "";
}

const INLINE = new Set(["a", "b", "code", "em", "i", "span", "strong"]);

/**
 * A heading's anchor: lower case, ASCII letters and digits, hyphens between words. Apostrophes
 * vanish rather than splitting a word, so "repository’s" stays one word.
 */
export function slugify(text: string): string {
  return text
    .normalize("NFKD")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
