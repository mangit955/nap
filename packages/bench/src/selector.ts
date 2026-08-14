/**
 * How a check names an element, without naming any markup.
 *
 * A selector here is a value — four ways of asking, each a field or two — rather than a CSS
 * or XPath string. Two reasons, and both are load-bearing.
 *
 * The first is that a benchmark measures a *generated* application. Nobody wrote its markup,
 * so nobody can write a selector against it: `.btn-primary` is a guess about a class name a
 * model happened to emit, and a check that fails because the agent used Tailwind instead of
 * CSS modules is measuring nothing. Role, label, text and test id are the four things a
 * generated page can be asked for that survive being restyled, because they are what the
 * page *means* rather than how it is built.
 *
 * The second is that this is the seam the fake has to implement. A raw selector string can
 * only be answered by a real engine, which would put every browser assertion behind Chrome
 * and out of the free suite. A closed set of four questions can be answered by a `filter`
 * over a list, which is exactly what `ScriptedBrowserSession` does.
 */

import { z } from "zod";

/**
 * The four ways to name an element, discriminated so a task file cannot half-fill one.
 *
 * `role` is a plain string rather than an enum of the ARIA roles. The list belongs to the
 * platform and is long, extended by WAI-ARIA revisions rather than by us, and pinning a copy
 * of it here would eventually reject a role that browsers accept. The failure mode is mild in
 * any case: an unknown role matches nothing and its assertion fails loudly, unlike a
 * misspelled *field* name, which a strict object catches precisely because it would otherwise
 * be ignored in silence.
 */
export const SelectorSchema = z.discriminatedUnion("by", [
  z.strictObject({
    by: z.literal("role"),
    role: z.string().min(1),
    /** The accessible name, when the role alone is ambiguous — usually the visible label. */
    name: z.string().min(1).optional(),
  }),
  z.strictObject({ by: z.literal("label"), text: z.string().min(1) }),
  z.strictObject({ by: z.literal("text"), text: z.string().min(1) }),
  z.strictObject({ by: z.literal("testId"), id: z.string().min(1) }),
]);

export type Selector = z.infer<typeof SelectorSchema>;

/**
 * A selector as a phrase, for the sentence a failing check leaves behind.
 *
 * Every browser failure is read months later by somebody who cannot re-run it, so the detail
 * has to say what was looked for. Built here rather than at each call site so that one
 * selector reads the same in every message it appears in.
 */
export function describeSelector(selector: Selector): string {
  switch (selector.by) {
    case "role":
      return selector.name === undefined
        ? `role=${selector.role}`
        : `role=${selector.role} named "${selector.name}"`;
    case "label":
      return `labelled "${selector.text}"`;
    case "text":
      return `text "${selector.text}"`;
    case "testId":
      return `test id "${selector.id}"`;
  }
}
