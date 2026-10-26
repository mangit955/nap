import type { ComputerAnnotation } from "@nap/shared/computer";
import type { DesktopAction } from "@nap/shared/ports/sandbox-desktop";
import type { Result } from "@nap/shared/result";

type Assertion = {
  chapter: string;
  expectation: string;
  result: "passed" | "failed" | "untested";
  declaredAfter: number;
};
type AnnotationResult = Result<void, { message: string }>;

/** A verdict needs confirmed input and a later screenshot delivered to the model. */
export class AppTestRun {
  readonly #now: () => number;
  readonly #emit: (entry: { annotation: ComputerAnnotation; timeMs: number }) => void;
  readonly #startedAt: number;
  readonly #chapters = new Set<string>();
  readonly #assertions = new Map<string, Assertion>();
  readonly #screenshots = new Map<string, number>();
  #chapter: string | null = null;
  #setup = false;
  #action = 0;
  #confirmedAction = 0;
  #failedAction = 0;
  #observedAction = 0;

  constructor(options: {
    now?: () => number;
    emit: (entry: { annotation: ComputerAnnotation; timeMs: number }) => void;
  }) {
    this.#now = options.now ?? Date.now;
    this.#startedAt = this.#now();
    this.#emit = options.emit;
  }

  async annotate(
    annotation: ComputerAnnotation,
    clock?: () => Promise<number | null>,
  ): Promise<AnnotationResult> {
    const refuse = (message: string): AnnotationResult => ({ ok: false, error: { message } });
    switch (annotation.type) {
      case "setup":
        if (this.#chapter !== null) return refuse("Setup must precede the first test.");
        this.#setup = true;
        break;
      case "test_start":
        if (this.#chapters.has(annotation.id)) return refuse("Test IDs must be unique.");
        this.#chapters.add(annotation.id);
        this.#chapter = annotation.id;
        break;
      case "action":
        if (!this.#pending())
          return refuse("State an untested assertion before describing the action.");
        break;
      case "assertion": {
        if (this.#chapter === null) return refuse("Start a test before declaring its assertion.");
        const previous = this.#assertions.get(annotation.id);
        if (annotation.result === "untested") {
          if (previous)
            return refuse(
              "Assertion IDs must be unique; update the existing assertion with its verdict.",
            );
          this.#assertions.set(annotation.id, {
            chapter: this.#chapter,
            expectation: annotation.expectation,
            result: "untested",
            declaredAfter: this.#action,
          });
        } else {
          if (
            !previous ||
            previous.chapter !== this.#chapter ||
            previous.expectation !== annotation.expectation ||
            previous.result !== "untested"
          )
            return refuse("A verdict must match an untested assertion in the current test.");
          if (this.#observedAction <= previous.declaredAfter)
            return refuse(
              "Perform the action and inspect a new screenshot before assigning a verdict.",
            );
          previous.result = annotation.result;
        }
        break;
      }
    }
    const timeMs = clock ? await clock() : null;
    this.#emit({
      annotation: { ...annotation },
      timeMs: timeMs ?? Math.max(0, Math.round(this.#now() - this.#startedAt)),
    });
    return { ok: true, value: undefined };
  }

  beforeAction(action: DesktopAction): AnnotationResult {
    if (!this.#isInput(action)) return { ok: true, value: undefined };
    if (this.#chapter === null ? !this.#setup : !this.#pending())
      return {
        ok: false,
        error: { message: "Record setup or an untested assertion before computer input." },
      };
    return { ok: true, value: undefined };
  }

  afterAction(action: DesktopAction, succeeded: boolean): void {
    if (!this.#isInput(action)) return;
    this.#action += 1;
    if (succeeded) {
      this.#confirmedAction = this.#action;
    } else {
      this.#confirmedAction = 0;
      this.#failedAction = this.#action;
      this.#observedAction = 0;
    }
  }

  screenshotStored(toolCallId: string): void {
    this.#screenshots.set(toolCallId, this.#confirmedAction);
  }

  delivered(toolCallIds: readonly string[]): void {
    for (const id of toolCallIds) {
      const action = this.#screenshots.get(id);
      if (action !== undefined && action > this.#failedAction)
        this.#observedAction = Math.max(this.#observedAction, action);
    }
  }

  #isInput(action: DesktopAction): boolean {
    switch (action.action) {
      case "screenshot":
      case "cursor_position":
      case "read_dom":
      case "console":
      case "wait":
      case "zoom":
        return false;
      default:
        return true;
    }
  }

  counts(): { passed: number; failed: number; untested: number } {
    const counts = { passed: 0, failed: 0, untested: 0 };
    for (const assertion of this.#assertions.values()) counts[assertion.result] += 1;
    return counts;
  }

  #pending(): boolean {
    return [...this.#assertions.values()].some(
      (entry) => entry.chapter === this.#chapter && entry.result === "untested",
    );
  }
}
