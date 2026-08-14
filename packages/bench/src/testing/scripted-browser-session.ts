/**
 * A `BrowserSession` that is a list of elements and a handful of rules.
 *
 * This is the reason the browser half of NapBench is testable at all. Every action and every
 * assertion in `browser-executor.ts` is exercised against this instead of against Chrome, in
 * the free deterministic suite, and the tasks in the benchmark are authored and schema-checked
 * against it long before the Playwright adapter exists.
 *
 * **It models the browser's own behaviour and scripts the application's.** Clicking something
 * that is not there fails, filling an input changes its value, reloading throws away anything
 * the page had not saved — those are properties of a browser, so they are implemented here
 * rather than restated by every test. What a *particular* application does in response — a
 * to-do appearing, a filter shortening a list, a route changing — is the thing under test, so
 * it is supplied per test as a handler that mutates the page.
 *
 * The reload rule is the one worth spelling out, because "state survives a reload" is a check
 * the benchmark has to be able to express and get wrong. An element added by a handler is gone
 * after a reload unless the handler said it `persists`, which is the fake's stand-in for the
 * application having actually stored it. A generated application that only pushes a row into
 * a React array behaves like the first; one that writes to local storage behaves like the
 * second; the check that tells them apart is the same check either way.
 */

import type { Result, VoidResult } from "@nap/shared/result";
import type {
  BrowserCallOptions,
  BrowserError,
  BrowserErrorCode,
  BrowserSession,
  DocumentWidth,
} from "../browser-session.ts";
import type { Selector } from "../selector.ts";
import type { ViewportName, ViewportSize } from "../viewport.ts";
import { VIEWPORT_SIZES } from "../viewport.ts";

/** One element on the page, described by the four things a selector can ask about. */
export type ScriptedElement = {
  role?: string;
  /** Accessible name. Matched by a role selector's `name`, and by a label selector. */
  name?: string;
  label?: string;
  /** Text content. Matched as a substring, the way a real text selector does. */
  text?: string;
  testId?: string;
  /** Present but hidden is a state a generated application reaches often. Defaults to true. */
  visible?: boolean;
  attributes?: Record<string, string>;
  /** The live value of an input, which `fill` and `select` replace. */
  value?: string;
};

export type ScriptedPage = {
  elements?: readonly ScriptedElement[];
  /**
   * How wide the content is. A bare number applies everywhere; a map lets one page overflow
   * at mobile and fit at desktop, which is the whole subject of a responsive check.
   *
   * Absent means the content fits whatever the viewport currently is.
   */
  scrollWidth?: number | Partial<Record<ViewportName, number>>;
};

/** What a handler may do to the page: everything an application could have done itself. */
export interface ScriptedPageController {
  /** The current address, relative — path, query and fragment. */
  readonly path: string;
  /**
   * Adds an element. `persists` marks it as something the application saved, so that it comes
   * back after a reload; without it, the element is lost exactly as unsaved state would be.
   */
  add(element: ScriptedElement, opts?: { persists?: boolean }): void;
  /** Removes every element matching the selector, saved or not. */
  remove(selector: Selector): void;
  /** Changes the matching elements — hiding them, renaming them, setting an attribute. */
  update(selector: Selector, changes: Partial<ScriptedElement>): void;
  /** Client-side navigation, as a router would do it. */
  navigate(path: string): void;
}

export type ScriptedInteraction = {
  action: "click" | "fill" | "press" | "select";
  /** Absent only for a page-level key press. */
  selector?: Selector;
  key?: string;
  value?: string;
  page: ScriptedPageController;
};

/**
 * An application's reaction to one interaction: it mutates the page, as the application would.
 *
 * It cannot fail the interaction. Making a call fail is `fail`'s job, which covers every method
 * rather than only the four with handlers — two ways to say the same thing would leave the
 * error paths of the other ten untestable and nobody noticing.
 */
export type InteractionHandler = (interaction: ScriptedInteraction) => void;

/** Every call the executor made, in order, for tests that assert on the sequence. */
export type BrowserCall = {
  method:
    | "goto"
    | "reload"
    | "setViewport"
    | "click"
    | "fill"
    | "press"
    | "selectOption"
    | "url"
    | "isVisible"
    | "count"
    | "attribute"
    | "inputValue"
    | "documentWidth"
    | "close";
  url?: string;
  selector?: Selector;
  key?: string;
  value?: string;
  name?: string;
  viewport?: ViewportSize;
  timeoutMs?: number | undefined;
};

export type ScriptedBrowserSessionOptions = {
  /**
   * The pages this application has, by relative path. Navigating anywhere else fails the way
   * a real 404 that never renders would, rather than quietly serving an empty page.
   */
  pages?: Record<string, ScriptedPage>;
  /** The origin every page is served from. Only its shape matters. */
  origin?: string;
  /** What the application does in response to being interacted with. */
  on?: Partial<Record<ScriptedInteraction["action"], InteractionHandler>>;
  /**
   * Forces a call to fail, so that the executor's handling of a browser that misbehaves is
   * testable at every method rather than only where a selector happens to miss.
   */
  fail?: (call: BrowserCall) => BrowserError | undefined;
};

type LiveElement = ScriptedElement & { persists: boolean };

export class ScriptedBrowserSession implements BrowserSession {
  private readonly pages: Record<string, ScriptedPage>;
  private readonly origin: string;
  private readonly handlers: NonNullable<ScriptedBrowserSessionOptions["on"]>;
  private readonly failWith: ScriptedBrowserSessionOptions["fail"];
  /** Elements a handler saved, by path, re-applied whenever that path is loaded again. */
  private readonly saved = new Map<string, LiveElement[]>();

  private path = "/";
  private live: LiveElement[] = [];
  private viewport: ViewportSize = VIEWPORT_SIZES.desktop;
  private closed = false;

  readonly calls: BrowserCall[] = [];

  constructor(options: ScriptedBrowserSessionOptions = {}) {
    this.pages = options.pages ?? { "/": {} };
    this.origin = options.origin ?? "https://preview.example";
    this.handlers = options.on ?? {};
    this.failWith = options.fail;
    this.load(this.path);
  }

  async goto(url: string, opts?: BrowserCallOptions): Promise<VoidResult<BrowserError>> {
    const refused = this.record({ method: "goto", url, timeoutMs: opts?.timeoutMs });
    if (refused) return refused;

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return err("navigation_failed", `not a URL: ${url}`);
    }

    const path = `${parsed.pathname}${parsed.search}${parsed.hash}`;
    if (this.pageAt(path) === undefined) {
      return err("navigation_failed", `nothing is served at ${path}`);
    }

    this.load(path);
    return { ok: true, value: undefined };
  }

  async reload(opts?: BrowserCallOptions): Promise<VoidResult<BrowserError>> {
    const refused = this.record({ method: "reload", timeoutMs: opts?.timeoutMs });
    if (refused) return refused;

    // Everything not saved goes, which is the entire point of the method.
    this.load(this.path);
    return { ok: true, value: undefined };
  }

  async setViewport(size: ViewportSize): Promise<VoidResult<BrowserError>> {
    const refused = this.record({ method: "setViewport", viewport: size });
    if (refused) return refused;

    this.viewport = size;
    return { ok: true, value: undefined };
  }

  async click(selector: Selector, opts?: BrowserCallOptions): Promise<VoidResult<BrowserError>> {
    return this.interact({ method: "click", selector, timeoutMs: opts?.timeoutMs }, "click", {
      selector,
    });
  }

  async fill(
    selector: Selector,
    value: string,
    opts?: BrowserCallOptions,
  ): Promise<VoidResult<BrowserError>> {
    return this.interact(
      { method: "fill", selector, value, timeoutMs: opts?.timeoutMs },
      "fill",
      { selector, value },
      // A browser sets the value before anything the application does about it.
      (element) => {
        element.value = value;
      },
    );
  }

  async press(
    key: string,
    selector?: Selector,
    opts?: BrowserCallOptions,
  ): Promise<VoidResult<BrowserError>> {
    const call: BrowserCall = { method: "press", key, timeoutMs: opts?.timeoutMs };
    if (selector !== undefined) call.selector = selector;

    // A page-level press has no element to miss, so it skips the lookup entirely.
    if (selector === undefined) {
      const refused = this.record(call);
      if (refused) return refused;
      return this.react("press", { key });
    }

    return this.interact(call, "press", { selector, key });
  }

  async selectOption(
    selector: Selector,
    value: string,
    opts?: BrowserCallOptions,
  ): Promise<VoidResult<BrowserError>> {
    return this.interact(
      { method: "selectOption", selector, value, timeoutMs: opts?.timeoutMs },
      "select",
      { selector, value },
      (element) => {
        element.value = value;
      },
    );
  }

  async url(): Promise<Result<string, BrowserError>> {
    const refused = this.record({ method: "url" });
    if (refused) return refused;

    return { ok: true, value: `${this.origin}${this.path}` };
  }

  async isVisible(
    selector: Selector,
    opts?: BrowserCallOptions,
  ): Promise<Result<boolean, BrowserError>> {
    const refused = this.record({ method: "isVisible", selector, timeoutMs: opts?.timeoutMs });
    if (refused) return refused;

    return { ok: true, value: this.visibleMatches(selector).length > 0 };
  }

  async count(
    selector: Selector,
    opts?: BrowserCallOptions,
  ): Promise<Result<number, BrowserError>> {
    const refused = this.record({ method: "count", selector, timeoutMs: opts?.timeoutMs });
    if (refused) return refused;

    return { ok: true, value: this.visibleMatches(selector).length };
  }

  async attribute(
    selector: Selector,
    name: string,
    opts?: BrowserCallOptions,
  ): Promise<Result<string | null, BrowserError>> {
    const refused = this.record({
      method: "attribute",
      selector,
      name,
      timeoutMs: opts?.timeoutMs,
    });
    if (refused) return refused;

    const element = this.visibleMatches(selector)[0];
    if (element === undefined) return notFound(selector);

    return { ok: true, value: element.attributes?.[name] ?? null };
  }

  async inputValue(
    selector: Selector,
    opts?: BrowserCallOptions,
  ): Promise<Result<string, BrowserError>> {
    const refused = this.record({ method: "inputValue", selector, timeoutMs: opts?.timeoutMs });
    if (refused) return refused;

    const element = this.visibleMatches(selector)[0];
    if (element === undefined) return notFound(selector);

    return { ok: true, value: element.value ?? "" };
  }

  async documentWidth(): Promise<Result<DocumentWidth, BrowserError>> {
    const refused = this.record({ method: "documentWidth" });
    if (refused) return refused;

    return {
      ok: true,
      value: { scrollWidth: this.scrollWidth(), clientWidth: this.viewport.width },
    };
  }

  async close(): Promise<void> {
    this.calls.push({ method: "close" });
    this.closed = true;
  }

  /**
   * Records a call and answers whether it should fail.
   *
   * A closed session refuses everything: a composer that kept using a session after handing it
   * back has a bug the fake should surface rather than absorb.
   */
  private record(call: BrowserCall): { ok: false; error: BrowserError } | undefined {
    this.calls.push(call);
    if (this.closed) return err("unavailable", `the session is closed (${call.method})`);

    const failure = this.failWith?.(call);
    return failure === undefined ? undefined : { ok: false, error: failure };
  }

  /** The shared shape of every interaction: find it, do the browser's part, then the app's. */
  private async interact(
    call: BrowserCall,
    action: ScriptedInteraction["action"],
    event: Omit<ScriptedInteraction, "page" | "action">,
    onElement?: (element: LiveElement) => void,
  ): Promise<VoidResult<BrowserError>> {
    const refused = this.record(call);
    if (refused) return refused;

    const selector = event.selector;
    if (selector === undefined) throw new Error("an interaction with an element needs a selector");

    const element = this.visibleMatches(selector)[0];
    if (element === undefined) return notFound(selector);

    onElement?.(element);
    return this.react(action, event);
  }

  private react(
    action: ScriptedInteraction["action"],
    event: Omit<ScriptedInteraction, "page" | "action">,
  ): VoidResult<BrowserError> {
    this.handlers[action]?.({ ...event, action, page: this.controller() });
    return { ok: true, value: undefined };
  }

  private controller(): ScriptedPageController {
    const session = this;
    return {
      get path() {
        return session.path;
      },
      add(element, opts) {
        const persists = opts?.persists === true;
        const live: LiveElement = { ...element, persists };
        session.live.push(live);
        if (persists) session.savedAt(session.path).push(live);
      },
      remove(selector) {
        session.live = session.live.filter((element) => !matches(element, selector));
        const saved = session.savedAt(session.path);
        session.saved.set(
          session.path,
          saved.filter((element) => !matches(element, selector)),
        );
      },
      update(selector, changes) {
        for (const element of session.live) {
          if (matches(element, selector)) Object.assign(element, changes);
        }
      },
      navigate(path) {
        session.load(path);
      },
    };
  }

  /** Replaces the live page with a path's declared content plus whatever was saved there. */
  private load(path: string): void {
    this.path = path;
    const page = this.pageAt(path);
    this.live = [
      ...(page?.elements ?? []).map((element) => ({ ...element, persists: false })),
      ...this.savedAt(path).map((element) => ({ ...element })),
    ];
  }

  /**
   * A page's declaration, matched on the full relative address first and then on the path
   * alone — so a page declared once at `/todos` also answers at `/todos?filter=done`, which is
   * what a query-string filter in a generated application actually does.
   */
  private pageAt(path: string): ScriptedPage | undefined {
    const declared = this.pages[path];
    if (declared !== undefined) return declared;

    const withoutQuery = path.replace(/[?#].*$/, "");
    return this.pages[withoutQuery];
  }

  private savedAt(path: string): LiveElement[] {
    const withoutQuery = path.replace(/[?#].*$/, "");
    const existing = this.saved.get(withoutQuery);
    if (existing !== undefined) return existing;

    const created: LiveElement[] = [];
    this.saved.set(withoutQuery, created);
    return created;
  }

  private visibleMatches(selector: Selector): LiveElement[] {
    return this.live.filter((element) => element.visible !== false && matches(element, selector));
  }

  private scrollWidth(): number {
    const declared = this.pageAt(this.path)?.scrollWidth;
    if (declared === undefined) return this.viewport.width;
    if (typeof declared === "number") return declared;

    const name = (Object.keys(VIEWPORT_SIZES) as ViewportName[]).find(
      (candidate) => VIEWPORT_SIZES[candidate].width === this.viewport.width,
    );
    return (name === undefined ? undefined : declared[name]) ?? this.viewport.width;
  }
}

/** The four questions a selector can ask, answered against one element. */
function matches(element: ScriptedElement, selector: Selector): boolean {
  switch (selector.by) {
    case "role":
      if (element.role !== selector.role) return false;
      return selector.name === undefined || element.name === selector.name;
    case "label":
      return element.label === selector.text || element.name === selector.text;
    // Substring, as a real text selector is: a paragraph is found by a phrase inside it.
    case "text":
      return element.text?.includes(selector.text) ?? false;
    case "testId":
      return element.testId === selector.id;
  }
}

function err(code: BrowserErrorCode, message: string): { ok: false; error: BrowserError } {
  return { ok: false, error: { code, message } };
}

function notFound(selector: Selector): { ok: false; error: BrowserError } {
  return err("not_found", `no visible element matched ${JSON.stringify(selector)}`);
}
