/**
 * The one new seam NapBench introduces: a browser, behind an interface narrow enough to fake.
 *
 * Everything that drives or interrogates a generated application from outside goes through
 * here, and the entire action-and-assertion executor is written against it. That is what puts
 * every browser behaviour in the free deterministic suite: `ScriptedBrowserSession` answers
 * these methods out of a list of elements, so "does the filter change what is visible" is a
 * unit test rather than a Chrome launch. The real adapter lives in `apps/napbench` and is the
 * only thing in the repository allowed to know Playwright exists — see `docs/adr/0001`.
 *
 * **The methods are deliberately dumb.** They act, or they report a measurement; none of them
 * decides whether anything is *correct*. Horizontal overflow is the clearest case: the port
 * hands back two numbers and `browser-executor.ts` compares them, because a comparison that
 * lives inside the adapter is a comparison the fake would have to reimplement — and two
 * implementations of a judgement are two chances to disagree about what passed.
 *
 * **One session is one check.** Isolation between checks is the composer's job: it opens a
 * session, runs a check through it and closes it, so nothing a check leaves in local storage
 * or in the history can reach the next one. The port cannot enforce that, so it is stated
 * here as the contract an adapter is written against.
 *
 * Every method returns a `Result`. An element that is not there is an ordinary outcome on this
 * boundary — it is most of what a benchmark discovers — and a caller that forgets to handle it
 * should fail to compile.
 */

import type { Result, VoidResult } from "@nap/shared/result";
import type { Selector } from "./selector.ts";
import type { ViewportSize } from "./viewport.ts";

export type BrowserErrorCode =
  /** The driver itself: no browser, a crashed one, a context that would not open. */
  | "unavailable"
  /**
   * The page would not load: no response, a network error, a navigation that never settled.
   *
   * Reported, not judged — this says the browser did not get there, and deliberately not why.
   * An adapter must never read it as "the application is broken": the executor retries a first
   * arrival before believing it, and attributes one that keeps failing to the evaluator rather
   * than to the agent, because the preview probe had already proven that URL serves. See
   * docs/adr/0005.
   */
  | "navigation_failed"
  /** Nothing matched the selector within the timeout. */
  | "not_found"
  /** Something matched but would not do as it was told — covered, disabled, detached. */
  | "action_failed";

export type BrowserError = {
  code: BrowserErrorCode;
  message: string;
};

/**
 * Per-call deadline. Absent leaves it to the adapter's own default.
 *
 * Explicitly `| undefined` because the caller is a loop over steps that mostly do not declare
 * one, and forcing it to build the object conditionally at eleven call sites would be
 * ceremony in service of a distinction — omitted versus undefined — that means nothing here.
 */
export type BrowserCallOptions = { timeoutMs?: number | undefined };

export interface BrowserSession {
  /** Navigates to an absolute URL and waits for the page to be usable. */
  goto(url: string, opts?: BrowserCallOptions): Promise<VoidResult<BrowserError>>;

  /**
   * Reloads the current page.
   *
   * Its own method rather than a second `goto`, because the two ask different questions of an
   * application: navigating again may re-mount from scratch, while a reload is the thing a
   * user does to find out whether their data was actually saved.
   */
  reload(opts?: BrowserCallOptions): Promise<VoidResult<BrowserError>>;

  /** Resizes the viewport. Takes a size rather than a name so the names stay ours. */
  setViewport(size: ViewportSize): Promise<VoidResult<BrowserError>>;

  click(selector: Selector, opts?: BrowserCallOptions): Promise<VoidResult<BrowserError>>;

  /** Replaces the value of a text input, as typing into it would. */
  fill(
    selector: Selector,
    value: string,
    opts?: BrowserCallOptions,
  ): Promise<VoidResult<BrowserError>>;

  /**
   * Presses a key, on a specific element when one is named and on the page when not.
   *
   * The optional selector is what makes "type into the box and press Enter" expressible
   * without a separate focus call — which would be a second way to say the same thing, and a
   * piece of state for the fake to model.
   *
   * `timeoutMs` applies to *finding the element* and so means nothing when no selector is
   * given: a keypress aimed at the page waits for nothing. Adapters may ignore it on that
   * branch, and the option stays on the signature because a caller passing one blindly to
   * every step should not have to special-case this.
   */
  press(
    key: string,
    selector?: Selector,
    opts?: BrowserCallOptions,
  ): Promise<VoidResult<BrowserError>>;

  /** Chooses an option in a `<select>` by its value. */
  selectOption(
    selector: Selector,
    value: string,
    opts?: BrowserCallOptions,
  ): Promise<VoidResult<BrowserError>>;

  /** The current address, absolute, after any redirect the application performed. */
  url(): Promise<Result<string, BrowserError>>;

  /**
   * Whether at least one element matching the selector is visible to a user.
   *
   * Visible, not present: a benchmark asserting that a to-do appears means a user can see it,
   * and markup left in the document with `display: none` is not that. Missing is `false`
   * rather than an error, because "it is not there" is an answer to this question.
   */
  isVisible(selector: Selector, opts?: BrowserCallOptions): Promise<Result<boolean, BrowserError>>;

  /**
   * How many visible elements match. Zero is an answer, not a failure.
   *
   * Waits, like `isVisible` — a count taken the instant a page loads reads zero for any
   * application that fetches before it paints. Which means an *expected* zero costs the whole
   * deadline before it can be believed, exactly as proving any other negative does, so a check
   * asserting an empty list should say `timeoutMs` rather than pay the default for it.
   */
  count(selector: Selector, opts?: BrowserCallOptions): Promise<Result<number, BrowserError>>;

  /** An attribute of the first match, or null when the element has no such attribute. */
  attribute(
    selector: Selector,
    name: string,
    opts?: BrowserCallOptions,
  ): Promise<Result<string | null, BrowserError>>;

  /** The current value of an input, which is not the same as its `value` attribute. */
  inputValue(selector: Selector, opts?: BrowserCallOptions): Promise<Result<string, BrowserError>>;

  /**
   * The document's scrollable width against the width actually on screen.
   *
   * Two numbers rather than a verdict, so the rule that turns them into one — including how
   * many pixels of slop count as none — is pure, shared, and tested without a browser.
   */
  documentWidth(): Promise<Result<DocumentWidth, BrowserError>>;

  /**
   * Photographs the page as it stands, at whatever size the viewport currently is.
   *
   * Takes no arguments on purpose. "At the viewport the check ran at" is not a parameter — it
   * is a consequence of the check having set the viewport and this being called afterwards, and
   * a `width` here would be a second place for the two to disagree.
   *
   * An adapter that cannot say what size it photographed at must fail rather than guess. The
   * size is carried into an archived artefact that outlives the run, and a plausible-looking
   * fabricated number there is worse than a missing image: nobody reading it later can tell.
   */
  screenshot(): Promise<Result<Screenshot, BrowserError>>;

  /**
   * Runs an accessibility audit against the rendered page.
   *
   * A port method rather than a set of assertions, because accessibility is measured by an
   * established tool rather than by our judgement — what counts as a violation is axe's answer,
   * and the benchmark's job is to record it.
   */
  scanAccessibility(): Promise<Result<AccessibilityScan, BrowserError>>;

  /**
   * What went wrong in the page while the session was open, as opposed to what a check asked.
   *
   * Collected continuously and read at the end: an application that renders correctly while
   * throwing on every keystroke is not a working application, and nothing a check asserts would
   * notice. Implementations must have *settled* before answering — a browser requests some
   * things after load, so reading immediately catches them in some runs and not others, which
   * is an intermittent difference between two runs of the same task.
   */
  diagnostics(): Promise<Result<PageDiagnostics, BrowserError>>;

  /** Releases whatever the session was holding. Safe to call twice. */
  close(): Promise<void>;
}

export type Screenshot = {
  /** PNG bytes. The format is fixed because a report that mixed two would be unreadable. */
  bytes: Uint8Array;
  /** The size it was taken at, carried with it so a stored image is interpretable later. */
  viewport: ViewportSize;
};

/**
 * One thing an accessibility audit objected to, flattened.
 *
 * Deliberately not axe's own result shape: that is a large, versioned object with a node tree
 * inside it, and a report is archived and diffed for months. What survives is the rule that
 * fired, how bad it is, how many elements it hit, and where to read about it.
 */
export type AccessibilityViolation = {
  /** The rule's id — `image-alt`, `color-contrast`. Stable across versions of the tool. */
  id: string;
  impact: AccessibilityImpact;
  /** One line saying what is wrong, as the tool phrases it. */
  help: string;
  helpUrl: string;
  /** How many elements on the page broke this rule. */
  nodes: number;
};

/**
 * How serious a violation is, as the tool grades it, plus `unknown`.
 *
 * `unknown` exists because the field is optional in the tool's own output, and inventing
 * `minor` for an ungraded violation would understate it in a report nobody can re-derive.
 */
export const ACCESSIBILITY_IMPACTS = [
  "critical",
  "serious",
  "moderate",
  "minor",
  "unknown",
] as const;

export type AccessibilityImpact = (typeof ACCESSIBILITY_IMPACTS)[number];

export type AccessibilityScan = { violations: AccessibilityViolation[] };

export type FailedRequest = {
  url: string;
  /** What the browser said went wrong — a refused connection, a DNS failure, a 404. */
  failure: string;
};

/**
 * Named for the page rather than the session, because "session" is the word that collides.
 *
 * `CONTEXT.md` has a NapBench run containing Nap sessions containing turns, so a bare
 * `SessionDiagnostics` in an archived report reads as the *Nap* session's — which is a different
 * thing at a different scale. These are one page's complaints.
 */
export type PageDiagnostics = {
  /** Console messages at error level, in the order they were logged. */
  consoleErrors: string[];
  failedRequests: FailedRequest[];
};

export type DocumentWidth = {
  /** How wide the content is, including anything spilling past the right-hand edge. */
  scrollWidth: number;
  /** How wide the window showing it is. */
  clientWidth: number;
};

/**
 * Opens a session, or explains why it could not.
 *
 * A factory rather than a session, because the composer has to make a new one per check and
 * only the app knows how — and because "there is no browser on this host" has to be a typed
 * outcome that reaches the gate ladder, rather than an exception thrown halfway through a run
 * that has already spent money.
 */
export type BrowserSessionFactory = () => Promise<Result<BrowserSession, BrowserError>>;
