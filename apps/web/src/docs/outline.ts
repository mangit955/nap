/**
 * The shape of one section, read out of its prose: the lede, the subheadings, and the words under
 * each. The "On this page" list, the sidebar's sub-entries, the home page's cards and the search
 * index are all built from this.
 *
 * It works by calling the section's component as a function and walking the elements it returns,
 * which is sound because section components are plain functions of no props: no hooks, no state,
 * nothing that needs React to be rendering. `outline.test.tsx` calls it on every section, so a
 * section that ever grows a hook fails there rather than in production.
 *
 * Each section opens with `"use no memo"` for the same reason. React Compiler rewrites a component
 * to keep a cache through a hook, and a hook called outside a render throws. Next compiles only
 * the browser bundle, which the sections never reach, but the web tests compile everything; the
 * directive keeps the section a plain function in both, so the tests read what production runs.
 */

import { type ComponentType, Fragment, isValidElement, type ReactNode } from "react";
import { Facts, Figure, Lede, Recording, Sub } from "./prose.tsx";
import { slugify, textOf } from "./text.ts";

export type Heading = { id: string; text: string };

/** A run of prose: the text before the first subheading, or under one subheading. */
export type Block = { heading: Heading | null; text: string };

export type Outline = { lede: string; headings: Heading[]; blocks: Block[] };

export function outlineOf(Body: ComponentType): Outline {
  // A component typed as `ComponentType` may be a class; every section is a function.
  const render = Body as (props: Record<string, never>) => ReactNode;
  const blocks: Block[] = [{ heading: null, text: "" }];
  let lede = "";

  for (const node of flatten(render({}))) {
    if (!isValidElement<{ children?: ReactNode }>(node)) {
      append(blocks, textOf(node as ReactNode));
      continue;
    }
    if (node.type === Sub) {
      const text = textOf(node.props.children);
      blocks.push({ heading: { id: slugify(text), text }, text: "" });
      continue;
    }
    if (node.type === Lede && lede === "") lede = textOf(node.props.children);
    append(blocks, proseOf(node));
  }

  const headings = blocks.flatMap((block) => (block.heading ? [block.heading] : []));
  return { lede, headings, blocks: blocks.filter((block) => block.heading || block.text) };
}

/** The top-level nodes of a section, with fragments opened. */
function flatten(node: ReactNode): ReactNode[] {
  if (Array.isArray(node)) return node.flatMap(flatten);
  if (isValidElement<{ children?: ReactNode }>(node) && node.type === Fragment) {
    return flatten(node.props.children);
  }
  return [node];
}

/**
 * The words a reader would search for in one node. A figure's drawing is box-drawing characters
 * and padding, so only its caption counts; a list of facts keeps its words in a prop.
 */
function proseOf(node: React.ReactElement): string {
  const props = node.props as Record<string, unknown>;
  if (node.type === Figure) return String(props.label ?? "");
  if (node.type === Recording) return `${props.label ?? ""}. ${props.caption ?? ""}`;
  if (node.type === Facts) {
    const items = props.items as readonly { term: string; body: ReactNode }[];
    return items.map((item) => `${item.term}. ${textOf(item.body)}`).join(" ");
  }
  return textOf(node as ReactNode);
}

function append(blocks: Block[], text: string) {
  const block = blocks.at(-1);
  if (!block || text === "") return;
  block.text = block.text ? `${block.text} ${text}` : text;
}
