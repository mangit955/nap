/**
 * The one real `BrowserSession`: Chrome, driven by Playwright, against a generated app.
 *
 * It lives here and nowhere else. `docs/adr/0001` makes `playwright-core` an exclusive external
 * owned by this app, enforced by `test/architecture.ts`, so the production API can never grow a
 * dependency on an evaluation tool. Everything above this file is written against the port and
 * is exercised by `ScriptedBrowserSession` in the free suite — which is why this file contains
 * no judgement about whether anything *passed*. It clicks, it measures, it reports.
 *
 * **Handed an executable path, refusing to guess**, exactly as `@nap/capture` already does: a
 * benchmark that silently found *some* browser would produce numbers nobody could reproduce,
 * and a missing binary is a typed failure rather than a crash because it reaches the gate ladder
 * as an evaluator fault instead of being charged to the agent.
 *
 * **One browser, a context per check.** Launching Chrome costs a second or so and a suite is
 * dozens of checks, so the process is shared; the *context* is not, because isolation between
 * checks is the property that stops a check passing on what the last one left in local storage.
 *
 * **Findings from the preview-reachability spike, applied here.** Two of the three are visible
 * in this file: the favicon 404 is filtered out of diagnostics, and diagnostics settle before
 * they are read — Chrome requests the favicon *after* load, so an adapter that reads immediately
 * catches it in some runs and not others. The third — poll before navigating — is already done
 * upstream: a browser check only runs after `diagnosePreview` has confirmed the address serves,
 * so re-polling here would be a second implementation of a wait that already succeeded.
 *
 * **Requires a browser binary.** Nothing in the default test suite touches this file; its
 * integration test needs a Chrome at `NAP_CHROME_PATH` and skips without one, and driving a real
 * preview additionally needs an E2B sandbox and credentials.
 */

import {
  ACCESSIBILITY_IMPACTS,
  type AccessibilityImpact,
  type AccessibilityScan,
  type AccessibilityViolation,
  type BrowserCallOptions,
  type BrowserError,
  type BrowserErrorCode,
  type BrowserSession,
  type BrowserSessionFactory,
  type DocumentWidth,
  type FailedRequest,
  type Screenshot,
  type SessionDiagnostics,
} from "@nap/bench/browser-session";
import type { Selector } from "@nap/bench/selector";
import { VIEWPORT_SIZES, type ViewportSize } from "@nap/bench/viewport";
import type { Result, VoidResult } from "@nap/shared/result";
import { source as AXE_SOURCE } from "axe-core";
import {
  type Browser,
  type BrowserContext,
  chromium,
  type Locator,
  type Page,
} from "playwright-core";

/**
 * How long any one call waits before giving up.
 *
 * Generous, on the spike's evidence: navigation to an already-serving preview took 2.6 seconds,
 * nearly all of it transferring the document and its module graph. A tight default would record
 * a slow network as an application that does not work.
 */
const DEFAULT_TIMEOUT_MS = 15_000;

/** How long a count is watched for before it is taken to have settled. */
const COUNT_SETTLE_MS = 100;

/** How long `diagnostics` waits for the page to go quiet before reading what went wrong. */
const SETTLE_TIMEOUT_MS = 2_000;

export type PlaywrightBrowserOptions = {
  /** Path to a Chrome or Chromium binary. Nothing here looks for one. */
  executablePath: string;
};

/**
 * A launched browser, and the sessions it hands out.
 *
 * Two values rather than a factory alone because the process has to be closed by whoever
 * started it, and a factory that closed the browser with the last session would make the
 * lifetime depend on how many checks a task happened to declare.
 */
export type PlaywrightBrowser = {
  session: BrowserSessionFactory;
  close(): Promise<void>;
};

/**
 * Starts Chrome, or explains why it could not.
 *
 * The failure is typed and not thrown: "there is no browser on this host" has to reach the gate
 * ladder, which errors the run with kind `browser` rather than recording checks nobody could run
 * as the agent's failures.
 */
export async function launchPlaywrightBrowser(
  options: PlaywrightBrowserOptions,
): Promise<Result<PlaywrightBrowser, BrowserError>> {
  let browser: Browser;
  try {
    browser = await chromium.launch({
      executablePath: options.executablePath,
      headless: true,
      // Chrome's own sandbox needs privileges a container process usually lacks, and this
      // browser only ever loads an application we are already running ourselves.
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "unavailable",
        message: `could not start a browser at ${options.executablePath}: ${messageOf(error)}`,
      },
    };
  }

  return {
    ok: true,
    value: {
      session: async () => {
        try {
          const context = await browser.newContext({ viewport: { ...VIEWPORT_SIZES.desktop } });
          return {
            ok: true,
            value: await PlaywrightBrowserSession.open(context, DEFAULT_TIMEOUT_MS),
          };
        } catch (error) {
          return {
            ok: false,
            error: { code: "unavailable", message: `could not open a page: ${messageOf(error)}` },
          };
        }
      },
      close: async () => {
        // Best effort: a browser that will not close is a leaked process rather than a failed
        // run, and throwing here would lose whatever the run had already measured.
        await browser.close().catch(() => undefined);
      },
    },
  };
}

export class PlaywrightBrowserSession implements BrowserSession {
  readonly #context: BrowserContext;
  readonly #page: Page;
  readonly #timeout: number;
  readonly #consoleErrors: string[] = [];
  readonly #failedRequests: FailedRequest[] = [];

  private constructor(context: BrowserContext, page: Page, timeout: number) {
    this.#context = context;
    this.#page = page;
    this.#timeout = timeout;
  }

  static async open(context: BrowserContext, timeout: number): Promise<PlaywrightBrowserSession> {
    const page = await context.newPage();
    const session = new PlaywrightBrowserSession(context, page, timeout);
    session.#collectDiagnostics();
    return session;
  }

  /**
   * Listens for the whole life of the session, because that is what the port promises: an
   * application that renders correctly while throwing on every keystroke is not working, and no
   * assertion a check makes would notice.
   */
  #collectDiagnostics(): void {
    this.#page.on("console", (message) => {
      if (message.type() !== "error") return;

      // The address the message came from, kept with it. Chrome's own text for a failed
      // resource is "Failed to load resource: the server responded with a status of 404",
      // which names nothing — a line worth exactly nothing in an archived report, and the
      // reason the reachability spike could only *infer* that its one error was the favicon.
      const source = message.location().url;
      if (isBrowserNoise(source)) return;
      this.#consoleErrors.push(source === "" ? message.text() : `${message.text()} (${source})`);
    });

    // An uncaught exception is the error that matters most and is *not* a console message.
    this.#page.on("pageerror", (error) => {
      this.#consoleErrors.push(`uncaught ${error.name}: ${error.message}`);
    });

    this.#page.on("requestfailed", (request) => {
      if (isBrowserNoise(request.url())) return;
      this.#recordFailure(
        request.url(),
        request.failure()?.errorText ?? "the request failed",
        false,
      );
    });

    // A 404 on a data fetch is not a failed *request* to the browser, and it is exactly the
    // broken data loading a benchmark is looking for.
    this.#page.on("response", (response) => {
      if (response.status() < 400) return;
      if (isBrowserNoise(response.url())) return;
      this.#recordFailure(response.url(), `HTTP ${response.status()}`, true);
    });
  }

  /**
   * One entry per address, and the status wins.
   *
   * A single broken fetch arrives twice: the server answers 404, and Chrome then aborts the
   * request nobody read the body of. Recording both would report two broken things where there
   * is one, and `net::ERR_ABORTED` is the less useful of the two descriptions.
   */
  #recordFailure(url: string, failure: string, authoritative: boolean): void {
    const existing = this.#failedRequests.findIndex((request) => request.url === url);
    if (existing === -1) {
      this.#failedRequests.push({ url, failure });
      return;
    }
    if (authoritative) this.#failedRequests[existing] = { url, failure };
  }

  async goto(url: string, opts?: BrowserCallOptions): Promise<VoidResult<BrowserError>> {
    return this.#attempt("navigation", async () => {
      // `domcontentloaded` rather than `networkidle`: a Vite application serves an empty shell
      // and fetches its modules afterwards, and its dev server holds a socket open that keeps
      // the network from ever going idle. What a check actually needs is for its first selector
      // to resolve, and every one of them waits on its own.
      await this.#page.goto(url, { waitUntil: "domcontentloaded", timeout: this.#deadline(opts) });
    });
  }

  async reload(opts?: BrowserCallOptions): Promise<VoidResult<BrowserError>> {
    return this.#attempt("navigation", async () => {
      await this.#page.reload({ waitUntil: "domcontentloaded", timeout: this.#deadline(opts) });
    });
  }

  async setViewport(size: ViewportSize): Promise<VoidResult<BrowserError>> {
    return this.#attempt("page", async () => {
      await this.#page.setViewportSize({ width: size.width, height: size.height });
    });
  }

  async click(selector: Selector, opts?: BrowserCallOptions): Promise<VoidResult<BrowserError>> {
    return this.#attempt("element", async () => {
      await this.#locate(selector).click({ timeout: this.#deadline(opts) });
    });
  }

  async fill(
    selector: Selector,
    value: string,
    opts?: BrowserCallOptions,
  ): Promise<VoidResult<BrowserError>> {
    return this.#attempt("element", async () => {
      await this.#locate(selector).fill(value, { timeout: this.#deadline(opts) });
    });
  }

  async press(
    key: string,
    selector?: Selector,
    opts?: BrowserCallOptions,
  ): Promise<VoidResult<BrowserError>> {
    return this.#attempt(selector === undefined ? "page" : "element", async () => {
      if (selector === undefined) {
        // No deadline on this branch, and none is possible: a keypress with no element to find
        // waits for nothing, and Playwright's keyboard takes no timeout to give it.
        await this.#page.keyboard.press(key);
        return;
      }
      await this.#locate(selector).press(key, { timeout: this.#deadline(opts) });
    });
  }

  async selectOption(
    selector: Selector,
    value: string,
    opts?: BrowserCallOptions,
  ): Promise<VoidResult<BrowserError>> {
    return this.#attempt("element", async () => {
      await this.#locate(selector).selectOption(value, { timeout: this.#deadline(opts) });
    });
  }

  async url(): Promise<Result<string, BrowserError>> {
    return this.#ask("page", async () => this.#page.url());
  }

  /**
   * Waits for the element to appear, up to the deadline, and answers false if it never does.
   *
   * Waiting rather than sampling is the whole difference between an assertion that works and one
   * that races an application still rendering. It does mean an absence assertion pays the full
   * deadline before passing, which is the honest cost of proving a negative.
   */
  async isVisible(
    selector: Selector,
    opts?: BrowserCallOptions,
  ): Promise<Result<boolean, BrowserError>> {
    return this.#ask("element", async () => {
      try {
        // Filtered to the visible matches *before* taking the first, because the question is
        // whether any match is visible. Taking the first match and asking whether that one is
        // visible answers a different question, and answers it wrongly on exactly the page
        // that produces duplicates — a layout rendering one copy for mobile and hiding another.
        await this.#visible(selector)
          .first()
          .waitFor({
            state: "visible",
            timeout: this.#deadline(opts),
          });
        return true;
      } catch (error) {
        // Only a timeout means "it is not there". Anything else is the browser failing, and
        // `#ask` must see it rather than have it reported as a confident absence.
        if (!isTimeout(error)) throw error;
        return false;
      }
    });
  }

  async count(
    selector: Selector,
    opts?: BrowserCallOptions,
  ): Promise<Result<number, BrowserError>> {
    return this.#ask("element", async () => {
      // Counted after waiting, not sampled once. Every other query here auto-waits; a bare
      // count does not, and `Locator.isVisible`'s own timeout is documented as ignored — so a
      // count taken straight after a click reads whatever had rendered by then, which for any
      // application that fetches before it paints is zero.
      //
      // Waiting happens in two parts because "nothing yet" and "nothing at all" look
      // identical, and a settling rule alone cannot tell them apart: an empty page is
      // perfectly stable right up until it renders. So first wait for *something* to appear —
      // and if nothing ever does, zero is the answer, at the same price `isVisible` pays for
      // proving any other negative. Then let the number settle, because the first item to
      // arrive is rarely the last.
      const deadline = Date.now() + this.#deadline(opts);
      // Visible ones only, as the port says: markup left in the document with `display: none`
      // is not something a user can count.
      const visible = this.#visible(selector);

      try {
        await visible.first().waitFor({ state: "visible", timeout: this.#deadline(opts) });
      } catch (error) {
        if (!isTimeout(error)) throw error;
        return 0;
      }

      let previous = await visible.count();
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, COUNT_SETTLE_MS));
        const current = await visible.count();
        if (current === previous) return current;
        previous = current;
      }

      return previous;
    });
  }

  async attribute(
    selector: Selector,
    name: string,
    opts?: BrowserCallOptions,
  ): Promise<Result<string | null, BrowserError>> {
    return this.#ask("element", async () =>
      this.#locate(selector)
        .first()
        .getAttribute(name, { timeout: this.#deadline(opts) }),
    );
  }

  async inputValue(
    selector: Selector,
    opts?: BrowserCallOptions,
  ): Promise<Result<string, BrowserError>> {
    return this.#ask("element", async () =>
      this.#locate(selector)
        .first()
        .inputValue({ timeout: this.#deadline(opts) }),
    );
  }

  async documentWidth(): Promise<Result<DocumentWidth, BrowserError>> {
    return this.#ask("page", async () =>
      this.#page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      })),
    );
  }

  async screenshot(): Promise<Result<Screenshot, BrowserError>> {
    return this.#ask("page", async () => {
      const bytes = await this.#page.screenshot({ type: "png" });
      const size = this.#page.viewportSize();
      return {
        bytes: new Uint8Array(bytes),
        // A context is always created with a viewport, so this is only null if somebody
        // disabled it; desktop is the size such a page was laid out at anyway.
        viewport: size === null ? { ...VIEWPORT_SIZES.desktop } : size,
      };
    });
  }

  /**
   * Injects axe into the page and runs it.
   *
   * Injected rather than imported: the audit has to run inside the page it is auditing, against
   * the real computed accessibility tree. `axe.source` is the tool's own supported way of doing
   * that, so nothing here reimplements a rule.
   */
  async scanAccessibility(): Promise<Result<AccessibilityScan, BrowserError>> {
    return this.#ask("page", async () => {
      await this.#page.evaluate(AXE_SOURCE);
      // A callback rather than a string of script: `apps/napbench/tsconfig.json` pulls in the
      // DOM lib precisely so that what runs in the page is still checked. The declaration is
      // how the compiler is told about the global the line above just installed.
      const results = await this.#page.evaluate(() => {
        const axe = (globalThis as unknown as { axe: AxeGlobal }).axe;
        return axe.run(document, { resultTypes: ["violations"] });
      });

      return { violations: summariseViolations(results) };
    });
  }

  async diagnostics(): Promise<Result<SessionDiagnostics, BrowserError>> {
    return this.#ask("page", async () => {
      // Settle first, and this is load-bearing rather than defensive: `goto` resolves at
      // `domcontentloaded`, and both a failed data fetch and Chrome's own favicon request
      // arrive after that. Reading immediately catches them in some runs and not others, which
      // is an intermittent difference between two runs of one task — measured, by deleting
      // this wait and watching the diagnostics test fail.
      await this.#page.waitForLoadState("networkidle", { timeout: SETTLE_TIMEOUT_MS }).catch(
        // Best effort: a page that never goes quiet is a page with a socket open, which is
        // every Vite application. What it logged so far is still worth reading.
        () => undefined,
      );

      return {
        consoleErrors: [...this.#consoleErrors],
        failedRequests: [...this.#failedRequests],
      };
    });
  }

  async close(): Promise<void> {
    await this.#context.close().catch(() => undefined);
  }

  #deadline(opts?: BrowserCallOptions): number {
    return opts?.timeoutMs ?? this.#timeout;
  }

  /**
   * Turns a selector value into a Playwright locator.
   *
   * Role goes through the selector engine rather than `getByRole`, whose signature is a closed
   * union of every ARIA role: the port keeps `role` a string because that list belongs to the
   * platform, and a cast into the union would be a claim the compiler cannot check. An
   * unrecognised role fails when the locator resolves, as a typed error, which is what we want.
   */
  #locate(selector: Selector): Locator {
    switch (selector.by) {
      case "role":
        return this.#page.locator(
          selector.name === undefined
            ? `role=${selector.role}`
            : `role=${selector.role}[name=${JSON.stringify(selector.name)}]`,
        );
      case "label":
        return this.#page.getByLabel(selector.text);
      case "text":
        return this.#page.getByText(selector.text);
      case "testId":
        return this.#page.getByTestId(selector.id);
    }
  }

  /** The matches a user could actually see, which is what both counting queries mean. */
  #visible(selector: Selector): Locator {
    return this.#locate(selector).filter({ visible: true });
  }

  /** An action: it worked, or it produced a typed failure. */
  async #attempt(
    where: BrowserOperation,
    act: () => Promise<void>,
  ): Promise<VoidResult<BrowserError>> {
    const asked = await this.#ask(where, act);
    return asked.ok ? { ok: true, value: undefined } : asked;
  }

  /**
   * A query, with the one distinction the gate ladder depends on.
   *
   * A browser that has gone away is checked *before* the error is classified, because a closed
   * page produces an ordinary-looking failure that would otherwise be recorded as the
   * application's — which is the one direction this must never round.
   */
  async #ask<T>(where: BrowserOperation, ask: () => Promise<T>): Promise<Result<T, BrowserError>> {
    try {
      return { ok: true, value: await ask() };
    } catch (error) {
      if (this.#page.isClosed()) {
        return {
          ok: false,
          error: { code: "unavailable", message: `the page is gone: ${messageOf(error)}` },
        };
      }
      return { ok: false, error: browserErrorFor(error, where) };
    }
  }
}

/** Which kind of operation was being performed, which is what decides how a timeout reads. */
export type BrowserOperation = "navigation" | "element" | "page";

/**
 * The part of an axe violation this reads.
 *
 * Narrower than axe's own `Result`, so that a test can build one without casting its way past
 * the compiler — which is the checking such a test exists to do.
 */
export type AxeViolation = {
  id: string;
  impact?: string | null | undefined;
  help: string;
  helpUrl: string;
  nodes: readonly unknown[];
};

/**
 * Classifies a thrown value into the port's four codes.
 *
 * A timeout means different things in different places and that is the whole reason this exists:
 * waiting for an element that never appeared is `not_found`, which is a fact about the
 * application, while a page that would not load is `navigation_failed`. Anything that is not a
 * timeout is the browser refusing to do as it was told.
 */
export function browserErrorFor(error: unknown, where: BrowserOperation): BrowserError {
  const message = messageOf(error);
  if (where === "navigation") return { code: "navigation_failed", message };

  // A timed-out wait on an element is the element never having appeared. A page-level timeout
  // is the browser failing to answer, which is not a statement about any element.
  const code: BrowserErrorCode =
    isTimeout(error) && where === "element" ? "not_found" : "action_failed";
  return { code, message };
}

/**
 * Requests every generated application makes and none of them means anything.
 *
 * The favicon is the whole list, and it is here on evidence rather than suspicion: the sandbox
 * template declares no `<link rel="icon">` and has no `public/`, so Chrome asks for
 * `/favicon.ico`, the dev server 404s it, and *every* application the benchmark ever runs
 * produces an identical console error. Left in, it would sit in every trajectory and penalise
 * every task equally — which is worse than useless, because it looks like signal.
 */
export function isBrowserNoise(url: string): boolean {
  try {
    return new URL(url).pathname === "/favicon.ico";
  } catch {
    // Not a URL at all — a `data:` or `about:` source. Nothing to filter, so keep it.
    return false;
  }
}

/**
 * Flattens an axe run into the handful of fields a report can carry for months.
 *
 * Its own function so it is unit-tested without a browser: axe's output is the one part of this
 * file with a shape worth getting wrong, and the ungraded-impact case is exactly the one a real
 * page produces rarely enough to never be noticed.
 */
export function summariseViolations(results: {
  violations?: readonly AxeViolation[];
}): AccessibilityViolation[] {
  return (results.violations ?? []).map((violation) => ({
    id: violation.id,
    impact: impactOf(violation.impact),
    help: violation.help,
    helpUrl: violation.helpUrl,
    nodes: violation.nodes.length,
  }));
}

function impactOf(impact: string | null | undefined): AccessibilityImpact {
  // Read off the list that defines the type, rather than a second copy of it here that a new
  // grade would have to be added to twice.
  const known = ACCESSIBILITY_IMPACTS.find((candidate) => candidate === impact);
  // Ungraded rather than mild: guessing `minor` would understate a violation in a report
  // nobody can re-derive.
  return known ?? "unknown";
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && error.name === "TimeoutError";
}

/** Just enough of axe's browser global for the call this makes into it. */
type AxeGlobal = {
  run(
    context: Document,
    options: { resultTypes: string[] },
  ): Promise<{ violations: AxeViolation[] }>;
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
