/**
 * Turning a declared browser check into calls on the port, and the answers back into a result.
 *
 * This is where every judgement about a running application is made — is that text visible, is
 * that the right count, does the page overflow — and it makes them all out of two numbers and a
 * boolean at a time, so that the whole of it is exercised against a fake in the free suite. The
 * adapter underneath knows how to click; it never knows what passing means.
 *
 * **A check stops at its first failure.** Once an assertion about the page is wrong, the page
 * is no longer the one the rest of the sequence was written against, and going on would report
 * failures caused by the first one as if they were separate findings. The detail says which
 * step stopped it, because a browser check is the one kind whose failure is otherwise
 * impossible to reconstruct from an archived report.
 *
 * **A dead driver is not a failed check.** Every browser answer is either something about the
 * application — which is the agent's — or the evaluator having no browser to ask with, which is
 * ours. Only the first becomes a check result; the second comes back as an error for the gate
 * ladder to attribute, because a check recorded as failed is a permanent accusation and this
 * one would be false.
 */

import type { Result } from "@nap/shared/result";
import {
  type AccessibilityCheck,
  DEFAULT_FAIL_ON_IMPACT,
  describeViolations,
  disqualifying,
} from "./accessibility-check.ts";
import {
  type BrowserCheck,
  type BrowserStep,
  DEFAULT_OVERFLOW_TOLERANCE_PX,
  isAssertion,
} from "./browser-check.ts";
import type { BrowserError, BrowserSession } from "./browser-session.ts";
import type { CheckResult } from "./report.ts";
import { describeSelector, type Selector } from "./selector.ts";
import { categoryOf, flagsOf, weightOf } from "./task.ts";
import { DEFAULT_VIEWPORT_NAME, viewportSize } from "./viewport.ts";

export type BrowserCheckContext = {
  /** Where the application is actually being served, this run. */
  baseUrl: string;
};

/**
 * Runs one check to its end or to its first failure.
 *
 * The error case is narrow on purpose: `unavailable` means there is no browser to ask, and
 * nothing else does. Every other browser error is something the application did — a page that
 * would not load, an element that is not there — and is recorded as the check failing.
 */
export async function runBrowserCheck(
  session: BrowserSession,
  check: BrowserCheck,
  context: BrowserCheckContext,
): Promise<Result<CheckResult, BrowserError>> {
  const viewport = check.viewport ?? DEFAULT_VIEWPORT_NAME;
  // Through the same helpers the runner uses for a command check, so a default cannot be
  // changed in one place and quietly not the other.
  const declared = {
    checkId: check.id,
    kind: "browser",
    category: categoryOf(check),
    weight: weightOf(check),
    ...flagsOf(check),
  } as const;

  const failed = (detail: string): Result<CheckResult, BrowserError> => ({
    ok: true,
    value: { ...declared, outcome: "failed", detail },
  });

  // The opening moves belong to the executor rather than to the task: every check runs at a
  // size and starts at the application's front door, and making tasks say so would be two
  // lines of ceremony per check that could be forgotten in exactly one of them.
  const sized = await session.setViewport(viewportSize(viewport));
  if (!sized.ok) {
    if (sized.error.code === "unavailable") return { ok: false, error: sized.error };
    return failed(`could not size the viewport to ${viewport}: ${sized.error.message}`);
  }

  const opened = await session.goto(context.baseUrl, { timeoutMs: check.timeoutMs });
  if (!opened.ok) {
    if (opened.error.code === "unavailable") return { ok: false, error: opened.error };
    return failed(`could not open the application: ${opened.error.message}`);
  }

  for (const [index, step] of check.steps.entries()) {
    const outcome = await runStep(session, step, {
      baseUrl: context.baseUrl,
      // Not every step waits for anything — resizing and reading the address do not — so the
      // field is absent from those members rather than optional on all of them.
      timeoutMs: ("timeoutMs" in step ? step.timeoutMs : undefined) ?? check.timeoutMs,
    });

    if (outcome.driver !== undefined) return { ok: false, error: outcome.driver };
    if (outcome.failure !== undefined) {
      // One-based, because it is read against a numbered list a human wrote.
      const did = isAssertion(step) ? "assertion" : "action";
      return failed(`step ${index + 1}, ${did} ${step.step}: ${outcome.failure}`);
    }
  }

  return {
    ok: true,
    value: {
      ...declared,
      outcome: "passed",
      detail: `${check.steps.length} step${check.steps.length === 1 ? "" : "s"} passed at ${viewport}`,
    },
  };
}

/**
 * What one step came to.
 *
 * Three outcomes rather than a boolean: it worked, the application disappointed it (`failure`,
 * carrying the sentence that says how), or there is no browser (`driver`, which ends the run
 * rather than the check).
 */
type StepOutcome = { failure?: string; driver?: BrowserError };

type StepContext = { baseUrl: string; timeoutMs: number | undefined };

const PASSED: StepOutcome = {};

/**
 * One arm per step kind, and no `default`: a step added to the union without an arm here fails
 * the typecheck rather than falling through and being reported as having passed.
 */
async function runStep(
  session: BrowserSession,
  step: BrowserStep,
  context: StepContext,
): Promise<StepOutcome> {
  const opts = { timeoutMs: context.timeoutMs };

  switch (step.step) {
    case "navigate":
      return acted(await session.goto(`${context.baseUrl}${step.path}`, opts));

    case "click":
      return acted(await session.click(step.selector, opts));

    case "fill":
      return acted(await session.fill(step.selector, step.value, opts));

    case "press":
      return acted(await session.press(step.key, step.selector, opts));

    case "reload":
      return acted(await session.reload(opts));

    case "select":
      return acted(await session.selectOption(step.selector, step.value, opts));

    case "viewport":
      return acted(await session.setViewport(viewportSize(step.viewport)));

    case "expectText":
      return expectVisibility(session, textSelector(step.text), true, opts);

    case "expectNoText":
      return expectVisibility(session, textSelector(step.text), false, opts);

    case "expectVisible":
      return expectVisibility(session, step.selector, true, opts);

    case "expectCount": {
      const counted = await session.count(step.selector, opts);
      if (!counted.ok) return asked(counted.error);

      return counted.value === step.count
        ? PASSED
        : {
            failure: `expected ${step.count} matching ${describeSelector(step.selector)}, found ${counted.value}`,
          };
    }

    case "expectUrl": {
      const address = await session.url();
      if (!address.ok) return asked(address.error);

      const relative = relativeUrl(address.value);
      return relative === step.equals
        ? PASSED
        : { failure: `expected the address to be ${step.equals}, it was ${relative}` };
    }

    case "expectUrlContains": {
      const address = await session.url();
      if (!address.ok) return asked(address.error);

      const relative = relativeUrl(address.value);
      return relative.includes(step.text)
        ? PASSED
        : { failure: `expected the address to contain "${step.text}", it was ${relative}` };
    }

    case "expectAttribute": {
      const value = await session.attribute(step.selector, step.name, opts);
      if (!value.ok) return asked(value.error);

      if (value.value === step.equals) return PASSED;
      return {
        failure: `expected ${step.name} on ${describeSelector(step.selector)} to be ${quote(step.equals)}, it was ${quote(value.value)}`,
      };
    }

    case "expectInputValue": {
      const value = await session.inputValue(step.selector, opts);
      if (!value.ok) return asked(value.error);

      return value.value === step.equals
        ? PASSED
        : {
            failure: `expected ${describeSelector(step.selector)} to contain "${step.equals}", it contained "${value.value}"`,
          };
    }

    case "expectNoConsoleErrors": {
      const diagnostics = await session.diagnostics();
      if (!diagnostics.ok) return asked(diagnostics.error);

      const errors = diagnostics.value.consoleErrors;
      if (errors.length === 0) return PASSED;

      // The count *and* the first one: the count is what makes two runs comparable, and the
      // text is the only thing that makes the failure actionable without opening the trajectory.
      return {
        failure: `the page logged ${errors.length} error${errors.length === 1 ? "" : "s"}, the first being: ${errors[0]}`,
      };
    }

    case "expectNoHorizontalOverflow": {
      const width = await session.documentWidth();
      if (!width.ok) return asked(width.error);

      const tolerance = step.tolerancePx ?? DEFAULT_OVERFLOW_TOLERANCE_PX;
      const overflow = width.value.scrollWidth - width.value.clientWidth;
      return overflow <= tolerance
        ? PASSED
        : {
            failure: `the page is ${overflow}px wider than the ${width.value.clientWidth}px viewport`,
          };
    }
  }
}

/**
 * Text as a selector, so "is this text visible" and "is this element visible" are one question.
 *
 * Text visibility is not a separate capability of a browser — it is an element lookup that
 * happens to be by text — and giving it its own port method would mean a second implementation
 * of visibility for the adapter and the fake to disagree about.
 */
function textSelector(text: string): Selector {
  return { by: "text", text };
}

async function expectVisibility(
  session: BrowserSession,
  selector: Selector,
  wanted: boolean,
  opts: { timeoutMs: number | undefined },
): Promise<StepOutcome> {
  const visible = await session.isVisible(selector, opts);
  if (!visible.ok) return asked(visible.error);

  if (visible.value === wanted) return PASSED;
  return {
    failure: wanted
      ? `expected ${describeSelector(selector)} to be visible`
      : `expected ${describeSelector(selector)} not to be visible`,
  };
}

/**
 * An action's result, read as a step outcome.
 *
 * An action that could not be performed fails the check: the element it wanted was missing, or
 * would not respond, and either is a fact about the application. Only a missing browser is ours.
 */
function acted(result: { ok: true } | { ok: false; error: BrowserError }): StepOutcome {
  if (result.ok) return PASSED;
  if (result.error.code === "unavailable") return { driver: result.error };
  return { failure: `${result.error.code} — ${result.error.message}` };
}

/** The same reading, for the queries an assertion makes. */
function asked(error: BrowserError): StepOutcome {
  return acted({ ok: false, error });
}

/**
 * The part of an address a task can assert on: path, query and fragment.
 *
 * The host is whichever sandbox this run was given, so a check that compared whole URLs could
 * only ever be written against a sandbox that no longer exists.
 */
function relativeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return url;
  }
}

function quote(value: string | null): string {
  return value === null ? "absent" : `"${value}"`;
}

/**
 * Audits one page with the established tool, and decides whether what it found fails the check.
 *
 * Beside `runBrowserCheck` rather than in a module of its own because the two are the same
 * shape of thing: a check that needs a live browser session, driven to a page and turned into a
 * `CheckResult`, with `unavailable` handed back so the gate ladder can decide what a missing
 * browser means. What differs is only what happens once the page is open — steps there, one
 * audit here — and the opening moves are identical, which is why they are written once.
 *
 * The judgement about *which* findings matter is not made here: it is in
 * `accessibility-check.ts`, where it is a pure function with tests of its own.
 */
export async function runAccessibilityCheck(
  session: BrowserSession,
  check: AccessibilityCheck,
  context: BrowserCheckContext,
): Promise<Result<CheckResult, BrowserError>> {
  const viewport = check.viewport ?? DEFAULT_VIEWPORT_NAME;
  const failOn = check.failOn ?? DEFAULT_FAIL_ON_IMPACT;
  const declared = {
    checkId: check.id,
    kind: "accessibility",
    category: categoryOf(check),
    weight: weightOf(check),
    ...flagsOf(check),
  } as const;

  const failed = (detail: string): Result<CheckResult, BrowserError> => ({
    ok: true,
    value: { ...declared, outcome: "failed", detail },
  });

  const sized = await session.setViewport(viewportSize(viewport));
  if (!sized.ok) {
    if (sized.error.code === "unavailable") return { ok: false, error: sized.error };
    return failed(`could not size the viewport to ${viewport}: ${sized.error.message}`);
  }

  // The audit is of a page, so the path is part of what the check declares — a task that only
  // ever audits the front door says nothing and gets it.
  const url = `${context.baseUrl}${check.path ?? "/"}`;
  const opened = await session.goto(url, { timeoutMs: check.timeoutMs });
  if (!opened.ok) {
    if (opened.error.code === "unavailable") return { ok: false, error: opened.error };
    return failed(`could not open ${check.path ?? "/"}: ${opened.error.message}`);
  }

  const scan = await session.scanAccessibility();
  if (!scan.ok) {
    if (scan.error.code === "unavailable") return { ok: false, error: scan.error };
    // The tool could not run, which is not the application being inaccessible. Recorded as a
    // failure rather than dropped, because an absent check would renormalise its category away
    // and *raise* the score of a run nobody could audit. See docs/adr/0002.
    return failed(`could not audit the page: ${scan.error.message}`);
  }

  const disqualified = disqualifying(scan.value.violations, failOn);

  return {
    ok: true,
    value: {
      ...declared,
      outcome: disqualified.length === 0 ? "passed" : "failed",
      detail: describeViolations(disqualified, failOn),
    },
  };
}
