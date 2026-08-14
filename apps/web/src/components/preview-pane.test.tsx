import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ProjectPhase } from "../projects/project-phase.ts";
import { PREVIEW_TITLE, PreviewPane } from "./preview-pane.tsx";

/**
 * What each phase looks like on screen.
 *
 * The pane no longer folds a log or overrides what it finds — it is handed a phase and draws it, so
 * these tests name the state they mean instead of assembling events to reach it. Which events
 * produce which phase is `project-phase.test.ts`'s subject, and the record-versus-announcement
 * comparison that used to be asserted here lives there now.
 */

const running = (url = "https://5173-abc.e2b.dev", seq = 2): ProjectPhase => ({
  kind: "running",
  url,
  seq,
});

function show(phase: ProjectPhase) {
  return render(<PreviewPane phase={phase} />);
}

/** The iframe, or `null` — its identity is what a hard reload changes. */
const frame = () => screen.queryByTitle(PREVIEW_TITLE);

describe("the phases", () => {
  it("invites a first prompt before anything has been asked for", () => {
    show({ kind: "idle" });

    expect(screen.getByText(/describe an app/i)).toBeVisible();
    expect(frame()).toBeNull();
  });

  it("says the app is starting while the sandbox comes up", () => {
    // Not a bare spinner: the user should know what is being waited on, and that it is
    // expected to take a moment rather than being stuck.
    show({ kind: "starting" });

    expect(screen.getByText(/starting/i)).toBeVisible();
    expect(frame()).toBeNull();
  });

  it("waits, rather than inviting a prompt, while a running project's log arrives", () => {
    // The two-second window. The record says a sandbox is serving and the announcement naming it
    // has not landed yet; the old pane drew "Nothing running yet" over a project that was running.
    show({ kind: "opening" });

    expect(screen.getByText(/starting the dev server/i)).toBeVisible();
    expect(screen.queryByText(/describe an app/i)).toBeNull();
  });

  it("shows the app once the sandbox is serving", () => {
    show(running());

    expect(frame()).toHaveAttribute("src", "https://5173-abc.e2b.dev");
  });

  it("says what failed and what to do about it", () => {
    show({ kind: "failed", message: "no capacity" });

    // The reason in the interface's own words, the detail underneath, and an action — a bare
    // "something went wrong" leaves the user with nothing to do but reload the page.
    //
    // The exact wording comes from `failure-copy.ts`, which the transcript reads too: this pane
    // used to phrase the same `turn.failed` differently, so one failure looked like two problems
    // depending on which half of the screen you were looking at.
    expect(screen.getByText(/couldn't start/i)).toBeVisible();
    expect(screen.getByText(/no capacity/)).toBeVisible();
    expect(screen.getByText(/send the message again/i)).toBeVisible();
  });
});

describe("a project that has been put away", () => {
  it("takes the dead app off the screen and offers the way back", () => {
    // The address in the log belongs to a sandbox that no longer exists. Left in the frame it
    // renders the provider's "not found" page, which reads as the product being broken.
    show({ kind: "put-away" });

    expect(frame()).toBeNull();
    expect(screen.getByText(/put away/i)).toBeVisible();
    expect(screen.getByRole("button", { name: /resume/i })).toBeEnabled();
  });

  it("says the files are safe, because that is the question being asked", () => {
    show({ kind: "put-away" });

    expect(screen.getByText(/still (saved|there)/i)).toBeVisible();
  });

  it("offers no reload or open control, since there is nothing behind them", () => {
    show({ kind: "put-away" });

    expect(screen.queryByRole("button", { name: /reload/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /open/i })).not.toBeInTheDocument();
  });

  it("asks to be resumed exactly once per press", () => {
    const presses: number[] = [];
    render(<PreviewPane phase={{ kind: "put-away" }} onResume={() => presses.push(1)} />);

    fireEvent.click(screen.getByRole("button", { name: /resume/i }));

    expect(presses).toHaveLength(1);
  });

  it("cannot be pressed again while it comes back up", () => {
    // A start under way is the `starting` phase, whatever the log still says about the sandbox
    // that went — which is what stops the button offering to do something already happening.
    show({ kind: "starting" });

    expect(screen.getByText(/starting/i)).toBeVisible();
    expect(screen.queryByRole("button", { name: /resume/i })).not.toBeInTheDocument();
  });

  it("counts how long the wait has been going on", () => {
    // The one hard fact on this screen, and what tells slow apart from stuck. The rotating word
    // above it is flavour and hidden from readers; this line is what gets announced.
    show({ kind: "starting" });

    expect(screen.getByText(/starting the dev server/i)).toHaveTextContent(/\d+s/);
  });

  it("waits with the ghost rather than a spinner", () => {
    // The wait is tens of seconds in a pane with nothing else in it. Queried by class, which is
    // the same exception the syntax-highlighting tests take: an animated mark is decoration and
    // has no accessible surface at all — the sentence beside it is what a reader gets, and that
    // is asserted above.
    const { container } = render(<PreviewPane phase={{ kind: "starting" }} />);

    expect(container.querySelector(".nap-loader")).toBeInTheDocument();
  });

  it("shows a refusal next to the button that caused it", () => {
    render(
      <PreviewPane
        phase={{ kind: "put-away" }}
        resumeError="Could not open the project — you already have 2 running."
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent(/2 running/);
    // Still offered: the fix is closing another project, and then this is what they press.
    expect(screen.getByRole("button", { name: /resume/i })).toBeInTheDocument();
  });
});

describe("the frame itself", () => {
  it("is sandboxed, and keeps its own origin rather than this page's", () => {
    // The previewed app is written by a model from whatever the user typed. It runs on its
    // own origin, so `allow-same-origin` grants it nothing here — but dropping `allow-scripts`
    // would stop every React app in the template from running at all.
    show(running());

    const sandbox = frame()?.getAttribute("sandbox") ?? "";
    expect(sandbox).toContain("allow-scripts");
    expect(sandbox).toContain("allow-same-origin");
  });
});

describe("reloading", () => {
  it("replaces the frame when a new preview is announced", () => {
    // A cross-origin frame cannot be told to reload from this side; the only way is to throw the
    // element away and make a new one. So the test is about the node's identity — and the `seq` is
    // what says "a different announcement" rather than "the same one, mentioned again".
    const { rerender } = render(<PreviewPane phase={running()} />);
    const before = frame();

    rerender(<PreviewPane phase={running("https://5173-abc.e2b.dev", 3)} />);

    expect(frame()).not.toBe(before);
    expect(frame()).toBeInTheDocument();
  });

  it("keeps the same frame when nothing about the preview changed", () => {
    // The log delivers a new array on every event, so the phase is recomputed constantly.
    // Remounting on each one would reload the user's app every time the agent said anything.
    const { rerender } = render(<PreviewPane phase={running()} />);
    const before = frame();

    rerender(<PreviewPane phase={running()} />);

    expect(frame()).toBe(before);
  });

  it("replaces the frame when the bar asks for a reload", () => {
    // The button lives in the workspace's top bar now — it counts, and this pane's frame is
    // keyed on the count, because a cross-origin frame cannot be told to reload any other way.
    const { rerender } = render(<PreviewPane phase={running()} reloads={0} />);
    const before = frame();

    rerender(<PreviewPane phase={running()} reloads={1} />);

    expect(frame()).not.toBe(before);
  });

  it("sends the frame to the page the bar names", () => {
    const { rerender } = render(<PreviewPane phase={running()} route="/" />);
    const before = frame();

    rerender(<PreviewPane phase={running()} route="/pricing" />);

    expect(frame()).toHaveAttribute("src", "https://5173-abc.e2b.dev/pricing");
    // A different page is a different page: the frame has to be replaced, not merely re-src'd,
    // or an app that has navigated itself since would ignore the change.
    expect(frame()).not.toBe(before);
  });

  it("offers no reload control when there is nothing to reload", () => {
    show({ kind: "starting" });

    expect(screen.queryByRole("button", { name: /reload/i })).not.toBeInTheDocument();
  });
});

describe("the pane itself", () => {
  it("keeps its landmark in every state", () => {
    const { rerender } = show({ kind: "idle" });
    expect(screen.getByRole("region", { name: "Preview" })).toBeInTheDocument();

    rerender(<PreviewPane phase={running()} />);
    expect(screen.getByRole("region", { name: "Preview" })).toBeInTheDocument();
  });
});
