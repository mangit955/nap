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
  /** The page would not load: no response, a network error, a navigation that never settled. */
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

  /** How many visible elements match. Zero is an answer, not a failure. */
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

  /** Releases whatever the session was holding. Safe to call twice. */
  close(): Promise<void>;
}

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
