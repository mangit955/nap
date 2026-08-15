/**
 * A check that audits the rendered page with an established tool, rather than with our opinion.
 *
 * The third check kind, and the one whose *result* is not ours to define: what counts as an
 * accessibility violation is axe's answer, and the benchmark's job is to run it, decide which
 * findings are severe enough to fail on, and record what it found in terms a reader can act on.
 *
 * **The threshold is the whole design.** Accessibility findings come graded, and a check that
 * failed on every finding would fail on essentially every generated application — which is a
 * check that has stopped separating them, and therefore stopped measuring anything. One that
 * failed on none would be decorative. So a task declares the bar, the default sits at
 * `serious`, and the check's detail always says which bar was applied so a result read months
 * later is interpretable without the task file beside it.
 *
 * The port that performs the audit is `BrowserSession.scanAccessibility`; the driving is in
 * `browser-executor.ts` beside the other kind that needs a browser. Everything here is pure.
 */

import { z } from "zod";
import {
  ACCESSIBILITY_IMPACTS,
  type AccessibilityImpact,
  type AccessibilityViolation,
} from "./browser-session.ts";
import { CategorySchema } from "./category.ts";
import { ViewportNameSchema } from "./viewport.ts";

/**
 * The grades a task may set as its bar, worst first.
 *
 * `unknown` is deliberately not among them: it is not a severity, it is the absence of one, so
 * it cannot be a threshold. What happens to ungraded findings is decided below.
 */
export const FAIL_ON_IMPACTS = ["critical", "serious", "moderate", "minor"] as const;

export type FailOnImpact = (typeof FAIL_ON_IMPACTS)[number];

/**
 * Where the bar sits when a task does not say.
 *
 * `serious` rather than `minor`, because a benchmark check that everything fails ranks nothing
 * — and rather than `critical`, because contrast and labelling findings are exactly the ones a
 * generated application gets wrong and exactly the ones worth catching.
 */
export const DEFAULT_FAIL_ON_IMPACT: FailOnImpact = "serious";

/** A path within the application, not a URL: the run supplies the origin. */
const PathSchema = z.string().regex(/^\//, "must start with /");

export const AccessibilityCheckSchema = z.strictObject({
  id: z.string().min(1),
  kind: z.literal("accessibility"),
  /** Which page to audit. Absent means the application's front door. */
  path: PathSchema.optional(),
  /**
   * The size to audit at. Absent means desktop.
   *
   * Worth setting: a navigation that collapses into a menu button at 375px is a different
   * document from the one at 1280px, and only one of them may have a name on that button.
   */
  viewport: ViewportNameSchema.optional(),
  /** Findings at this grade or worse fail the check. Absent means `serious`. */
  failOn: z.enum(FAIL_ON_IMPACTS).optional(),
  /** How long the page is given to load before the audit runs. */
  timeoutMs: z.number().int().positive().optional(),
  /** Which axis this scores into. Absent means the default for the kind. */
  category: CategorySchema.optional(),
  weight: z.number().nonnegative().optional(),
  required: z.boolean().optional(),
});

export type AccessibilityCheck = z.infer<typeof AccessibilityCheckSchema>;

/** Worst to least bad, which is the order `ACCESSIBILITY_IMPACTS` is already declared in. */
const SEVERITY_ORDER: readonly AccessibilityImpact[] = ACCESSIBILITY_IMPACTS;

/**
 * The findings that fail a check at this bar.
 *
 * **An ungraded finding always counts.** The tool reports only violations, so one it declined
 * to grade is still a violation; dropping it would let a rule vanish from the benchmark for
 * want of a severity, and calling it `minor` would understate it in a report nobody can
 * re-derive. Counting it is the one choice that cannot silently lose a real finding — and the
 * detail names it, so a reader can see that is what happened.
 */
export function disqualifying(
  violations: readonly AccessibilityViolation[],
  failOn: FailOnImpact,
): AccessibilityViolation[] {
  const bar = SEVERITY_ORDER.indexOf(failOn);

  return violations.filter((violation) => {
    if (violation.impact === "unknown") return true;
    return SEVERITY_ORDER.indexOf(violation.impact) <= bar;
  });
}

/**
 * What the check found, in one line somebody can act on without re-running it.
 *
 * Always says the bar, including when nothing failed: "passed" means nothing at or above
 * `serious`, which is a different claim from "no findings at all" and the two must not be
 * readable as each other.
 */
export function describeViolations(
  violations: readonly AccessibilityViolation[],
  failOn: FailOnImpact,
): string {
  if (violations.length === 0) return `no violations at or above ${failOn}`;

  const listed = violations
    .map((violation) => `${violation.id} (${violation.impact}, ${violation.nodes} elements)`)
    .join(", ");

  return `${violations.length} violation${violations.length === 1 ? "" : "s"} at or above ${failOn}: ${listed}`;
}
