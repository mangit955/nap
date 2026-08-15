/**
 * What a browser check is: an ordered list of things to do to a running application, and
 * things that must be true while doing them.
 *
 * **One list, not two.** Actions and assertions interleave, because most of what is worth
 * asserting is a *change*: a to-do that appears after the button was pressed, a list that
 * shortens when the filter is set, an item still there after a reload. Two separate lists —
 * do all of this, then check all of that — could express none of those, and "state survives a
 * reload" would be inexpressible entirely.
 *
 * Steps are declarative values validated by schema, so a task file is data rather than code
 * against the browser port. That is what lets `defineTask` reject a malformed check as the
 * module loads, before a sandbox exists, and what lets the whole executor be driven by a fake.
 *
 * Assertion steps are prefixed `expect`, which is the only thing separating them from actions
 * in the union. `isAssertion` is the one place that knows it.
 */

import { z } from "zod";
import { CategorySchema } from "./category.ts";
import { SelectorSchema } from "./selector.ts";
import { ViewportNameSchema } from "./viewport.ts";

/**
 * How long a single step may take.
 *
 * Per step as well as per check, because one step in a sequence is routinely the slow one —
 * the first navigation of a cold dev server — and raising the whole check's budget to cover it
 * would also give every later assertion permission to hang.
 */
const TimeoutMsSchema = z.number().int().positive().optional();

/** Relative to the application's own address; the preview URL is not the task's to know. */
const PathSchema = z.string().regex(/^\//, "must start with /");

export const BrowserStepSchema = z.discriminatedUnion("step", [
  z.strictObject({ step: z.literal("navigate"), path: PathSchema, timeoutMs: TimeoutMsSchema }),
  z.strictObject({
    step: z.literal("click"),
    selector: SelectorSchema,
    timeoutMs: TimeoutMsSchema,
  }),
  z.strictObject({
    step: z.literal("fill"),
    selector: SelectorSchema,
    /** Empty is meaningful — clearing a field is a thing a user does. */
    value: z.string(),
    timeoutMs: TimeoutMsSchema,
  }),
  z.strictObject({
    step: z.literal("press"),
    /** A key name as the platform spells it: `Enter`, `Escape`, `ArrowDown`. */
    key: z.string().min(1),
    /** Absent presses the key on the page rather than on a particular element. */
    selector: SelectorSchema.optional(),
    timeoutMs: TimeoutMsSchema,
  }),
  z.strictObject({ step: z.literal("reload"), timeoutMs: TimeoutMsSchema }),
  z.strictObject({
    step: z.literal("select"),
    selector: SelectorSchema,
    value: z.string(),
    timeoutMs: TimeoutMsSchema,
  }),
  /**
   * Resizes mid-check, which is how one sequence can assert that a layout survives being
   * narrowed rather than only that it is right at one width.
   */
  z.strictObject({ step: z.literal("viewport"), viewport: ViewportNameSchema }),

  z.strictObject({
    step: z.literal("expectText"),
    text: z.string().min(1),
    timeoutMs: TimeoutMsSchema,
  }),
  /**
   * The negative. Its own step rather than a flag on the one above, because the two are
   * different assertions about a page and reading `visible: false` as "absent" is the sort of
   * double negative that gets a check written backwards.
   */
  z.strictObject({
    step: z.literal("expectNoText"),
    text: z.string().min(1),
    timeoutMs: TimeoutMsSchema,
  }),
  z.strictObject({
    step: z.literal("expectVisible"),
    selector: SelectorSchema,
    timeoutMs: TimeoutMsSchema,
  }),
  z.strictObject({
    step: z.literal("expectCount"),
    selector: SelectorSchema,
    /** Zero is legitimate: "the empty state has no list items" is an ordinary assertion. */
    count: z.number().int().nonnegative(),
    timeoutMs: TimeoutMsSchema,
  }),
  /**
   * The address, compared against the part of it a task can know. The host and port belong to
   * whichever sandbox this run happened to get, so only the path, query and fragment are
   * matched.
   */
  z.strictObject({ step: z.literal("expectUrl"), equals: PathSchema }),
  /**
   * The same question, asked of a substring — for the query parameter a filter sets, where
   * the rest of the address is the application's business rather than the check's.
   *
   * A second step rather than a second optional field on the one above, because "exactly one
   * of these two" is a rule a strict object cannot state and a task author would meet by
   * setting neither.
   */
  z.strictObject({ step: z.literal("expectUrlContains"), text: z.string().min(1) }),
  z.strictObject({
    step: z.literal("expectAttribute"),
    selector: SelectorSchema,
    name: z.string().min(1),
    /** Null asserts the attribute is absent, which is how `disabled` is checked for. */
    equals: z.string().nullable(),
    timeoutMs: TimeoutMsSchema,
  }),
  z.strictObject({
    step: z.literal("expectInputValue"),
    selector: SelectorSchema,
    equals: z.string(),
    timeoutMs: TimeoutMsSchema,
  }),
  /**
   * "Works on mobile", as an objective claim: nothing spills past the right-hand edge.
   *
   * The tolerance exists because browsers round sub-pixel layout up, so a page that fits
   * exactly can report one pixel more than the window. One pixel of slop is the default;
   * anything wider than that is a real overflow.
   */
  z.strictObject({
    step: z.literal("expectNoHorizontalOverflow"),
    tolerancePx: z.number().int().nonnegative().optional(),
  }),
]);

export type BrowserStep = z.infer<typeof BrowserStepSchema>;

/** How much slop counts as no overflow when a step does not say. */
export const DEFAULT_OVERFLOW_TOLERANCE_PX = 1;

export const BrowserCheckSchema = z.strictObject({
  id: z.string().min(1),
  kind: z.literal("browser"),
  /**
   * The size the whole sequence runs at. Absent means desktop.
   *
   * A field on the check rather than a kind of its own, so the same sequence can be declared
   * twice at two sizes instead of being written twice.
   */
  viewport: ViewportNameSchema.optional(),
  /** At least one: a check with no steps asserts nothing and would always pass. */
  steps: z.array(BrowserStepSchema).min(1),
  /** The default deadline for every step in this check that does not set its own. */
  timeoutMs: z.number().int().positive().optional(),
  /** Which axis this scores into. Absent means the default for the kind, which is browser. */
  category: CategorySchema.optional(),
  weight: z.number().nonnegative().optional(),
  required: z.boolean().optional(),
  /**
   * What this check's screenshot is meant to look like, as a path the task author supplies.
   *
   * **Nothing compares against it yet, and that is the point.** Reference-image comparison is
   * out of scope; the spec asks only that the path be expressible now, so that tasks can carry
   * references before the judge that reads them exists and no task file has to be revisited on
   * the day it does. It is recorded with each capture, so a comparison run later knows what the
   * image was measured against at the time rather than against a task file edited since.
   *
   * Declared per check rather than per task because a task routinely photographs several
   * viewports — the responsive task is the whole reason `viewport` is a field here — and one
   * reference for a task could never match more than one of them.
   */
  referenceScreenshot: z.string().min(1).optional(),
});

export type BrowserCheck = z.infer<typeof BrowserCheckSchema>;

/**
 * Whether a step asserts something, as opposed to doing something.
 *
 * The executor puts this in the sentence a failed check leaves behind, because the two mean
 * different things to whoever reads the report: a failed assertion is the application being
 * wrong, while a failed action is usually the application missing the thing the next assertion
 * was about to look at — and the second is often a broken page rather than a wrong one.
 */
export function isAssertion(step: BrowserStep): boolean {
  return step.step.startsWith("expect");
}
