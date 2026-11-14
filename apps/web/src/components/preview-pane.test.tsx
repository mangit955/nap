import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectPhase } from "../projects/project-phase.ts";
import { PREVIEW_TITLE, PreviewPane, SWAP_TIMEOUT_MS } from "./preview-pane.tsx";

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
  it("explains that a repository has no preview instead of claiming its server is starting", () => {
    show({ kind: "no-preview" });
    expect(screen.getByText("No preview configured")).toBeVisible();
    expect(screen.queryByText(/starting the dev server/i)).toBeNull();
    expect(frame()).toBeNull();
  });

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

describe("a new announcement", () => {
  // A restarted dev server or a recreated sandbox announces a new address, and the frame has to
  // be replaced to follow it. Replaced naively, the pane is white until the new server answers —
  // seconds, after a restore. So the new frame loads out of sight and the old one stays up.
  //
  // jsdom never fires `load` on a frame by itself, so every load here is the test's decision.

  const PROJECT = "p-1";
  const at = (seq: number) => running(`https://5173-v${seq}.e2b.dev`, seq);
  const pane = (phase: ProjectPhase) => <PreviewPane projectId={PROJECT} phase={phase} />;
  const frames = () => screen.queryAllByTitle(PREVIEW_TITLE);
  const frameFor = (seq: number) =>
    frames().find((node) => node.getAttribute("src") === `https://5173-v${seq}.e2b.dev`);

  /** A pane whose first frame has loaded, so what follows is a replacement and not a first load. */
  function showing(seq: number) {
    const view = render(pane(at(seq)));
    const first = frameFor(seq);
    if (first === undefined) throw new Error("no first frame");
    fireEvent.load(first);
    return view;
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps the old frame up until the new one has loaded, then removes it", () => {
    const { rerender } = showing(2);
    const old = frameFor(2);

    rerender(pane(at(3)));

    expect(frames()).toHaveLength(2);
    expect(old).toBeVisible();
    const next = frameFor(3);
    expect(next).not.toBeVisible();

    fireEvent.load(next as HTMLElement);

    expect(frames()).toHaveLength(1);
    expect(old).not.toBeInTheDocument();
    // The same element, not a new one at the same address: anything else loads the app twice.
    expect(frames()[0]).toBe(next);
    expect(next).toBeVisible();
  });

  it("takes the old frame out of reach while it is being replaced, and says so", () => {
    // It may be the address of a sandbox that no longer exists: a click must not land on it and a
    // reader must not be sent into it, and what is on screen must not pass for the live app.
    const { rerender } = showing(2);
    const old = frameFor(2);
    expect(old).not.toHaveAttribute("inert");
    expect(old).not.toHaveAttribute("aria-hidden");

    rerender(pane(at(3)));

    expect(old).toHaveAttribute("inert");
    expect(old).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByRole("status")).toHaveTextContent(/updating the preview/i);

    fireEvent.load(frameFor(3) as HTMLElement);

    expect(frameFor(3)).not.toHaveAttribute("inert");
    expect(frameFor(3)).not.toHaveAttribute("aria-hidden");
    expect(screen.queryByText(/updating the preview/i)).toBeNull();
  });

  it("swaps anyway when the new frame never says it loaded", () => {
    vi.useFakeTimers();
    const { rerender } = showing(2);

    rerender(pane(at(3)));
    act(() => vi.advanceTimersByTime(SWAP_TIMEOUT_MS - 1));
    expect(frames()).toHaveLength(2);

    act(() => vi.advanceTimersByTime(1));

    expect(frames()).toHaveLength(1);
    expect(frameFor(3)).toBeVisible();
    expect(frameFor(3)).not.toHaveAttribute("inert");
  });

  it("draws the app on white once it has loaded, and not a moment before", () => {
    // White is what an app that sets no background of its own has always rendered on, so a loaded
    // frame keeps it. A frame shown before it has loaded — the timeout's doing — shows the pane
    // through it instead, because white there is exactly the flash this pane exists to avoid.
    vi.useFakeTimers();
    const { rerender } = showing(2);
    expect(frameFor(2)).toHaveStyle({ backgroundColor: "rgb(255, 255, 255)" });

    rerender(pane(at(3)));
    act(() => vi.advanceTimersByTime(SWAP_TIMEOUT_MS));
    expect(frameFor(3)).toBeVisible();
    expect(frameFor(3)).not.toHaveStyle({ backgroundColor: "rgb(255, 255, 255)" });

    fireEvent.load(frameFor(3) as HTMLElement);
    expect(frameFor(3)).toHaveStyle({ backgroundColor: "rgb(255, 255, 255)" });
  });

  it("never holds more than two frames, and ends on the newest", () => {
    // Each announcement supersedes the one still loading; only the frame on screen is kept.
    const { rerender } = showing(2);

    for (const seq of [3, 4, 5]) {
      rerender(pane(at(seq)));
      expect(frames().length).toBeLessThanOrEqual(2);
      expect(frameFor(2)).toBeVisible();
    }
    expect(frameFor(3)).toBeUndefined();
    expect(frameFor(4)).toBeUndefined();

    fireEvent.load(frameFor(5) as HTMLElement);

    expect(frames()).toHaveLength(1);
    expect(frameFor(5)).toBeVisible();
  });

  it("leaves no timer behind when the pane goes away mid-swap", () => {
    vi.useFakeTimers();
    const { rerender, unmount } = showing(2);
    rerender(pane(at(3)));

    unmount();

    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("reloading on purpose", () => {
  // A reload and a change of page are things the user asked for, so they look like what they
  // are: the frame goes at once and a loading state stands in for it. Holding the old page up
  // would make the button look as if it had done nothing.

  it("keeps the same frame when nothing about the preview changed", () => {
    // The log delivers a new array on every event, so the phase is recomputed constantly.
    // Remounting on each one would reload the user's app every time the agent said anything.
    const { rerender } = render(<PreviewPane phase={running()} />);
    const before = frame();

    rerender(<PreviewPane phase={running()} />);

    expect(frame()).toBe(before);
  });

  it("replaces the frame at once when the bar asks for a reload, and shows it reloading", () => {
    // The button lives in the workspace's top bar — it counts, and this pane's frame is keyed on
    // the count, because a cross-origin frame cannot be told to reload any other way.
    const { rerender } = render(<PreviewPane phase={running()} reloads={0} />);
    const before = frame();
    fireEvent.load(before as HTMLElement);

    rerender(<PreviewPane phase={running()} reloads={1} />);

    expect(before).not.toBeInTheDocument();
    expect(screen.getAllByTitle(PREVIEW_TITLE)).toHaveLength(1);
    expect(screen.getByRole("status")).toHaveTextContent(/loading the preview/i);

    fireEvent.load(frame() as HTMLElement);

    expect(screen.queryByText(/loading the preview/i)).toBeNull();
    expect(frame()).toBeVisible();
  });

  it("sends the frame to the page the bar names, the same way", () => {
    const { rerender } = render(<PreviewPane phase={running()} route="/" />);
    const before = frame();
    fireEvent.load(before as HTMLElement);

    rerender(<PreviewPane phase={running()} route="/pricing" />);

    expect(frame()).toHaveAttribute("src", "https://5173-abc.e2b.dev/pricing");
    // A different page is a different page: the frame has to be replaced, not merely re-src'd,
    // or an app that has navigated itself since would ignore the change.
    expect(before).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(/loading the preview/i);
  });

  it("offers no reload control when there is nothing to reload", () => {
    show({ kind: "starting" });

    expect(screen.queryByRole("button", { name: /reload/i })).not.toBeInTheDocument();
  });
});

describe("starting up", () => {
  const A = "project-a";
  const B = "project-b";
  const pictureOf = (projectId: string) => ({
    projectId,
    src: `https://api.test/projects/${projectId}/thumbnail?v=1`,
  });
  const snapshot = () => screen.queryByRole("img", { name: /last snapshot/i });

  it("shows the project's last picture, marked as not live, under the loader", () => {
    render(<PreviewPane projectId={A} phase={{ kind: "starting" }} thumbnail={pictureOf(A)} />);

    const picture = snapshot();
    expect(picture).toHaveAttribute("src", pictureOf(A).src);
    fireEvent.load(picture as HTMLElement);

    expect(screen.getByText(/not live/i)).toBeVisible();
    // The wait is still what the pane is about: the picture is behind it, not instead of it.
    expect(screen.getByText(/starting the dev server/i)).toBeVisible();
  });

  it("falls back to the plain loader when there is no picture to show", () => {
    // The ordinary case for a project that has never finished a turn: the route answers 404.
    render(<PreviewPane projectId={A} phase={{ kind: "starting" }} thumbnail={pictureOf(A)} />);

    fireEvent.error(snapshot() as HTMLElement);

    expect(snapshot()).toBeNull();
    expect(screen.queryByText(/not live/i)).toBeNull();
    expect(screen.getByText(/starting the dev server/i)).toBeVisible();
  });

  it("keeps the start-up screen over the first frame until that frame has loaded", () => {
    const { rerender } = render(
      <PreviewPane projectId={A} phase={{ kind: "starting" }} thumbnail={pictureOf(A)} />,
    );

    rerender(<PreviewPane projectId={A} phase={running()} thumbnail={pictureOf(A)} />);

    expect(frame()).not.toBeVisible();
    expect(screen.getByText(/starting the dev server/i)).toBeVisible();

    fireEvent.load(frame() as HTMLElement);

    expect(frame()).toBeVisible();
    expect(screen.queryByText(/starting the dev server/i)).toBeNull();
    expect(snapshot()).toBeNull();
  });

  it("never shows one project's picture for another", () => {
    // A caller whose record has not caught up with a switch still hands over the last project's
    // picture. The pane is told which project it is showing, and refuses anyone else's.
    const { rerender } = render(
      <PreviewPane projectId={A} phase={{ kind: "starting" }} thumbnail={pictureOf(A)} />,
    );
    expect(snapshot()).toHaveAttribute("src", pictureOf(A).src);

    rerender(<PreviewPane projectId={B} phase={{ kind: "starting" }} thumbnail={pictureOf(A)} />);
    expect(snapshot()).toBeNull();

    rerender(<PreviewPane projectId={B} phase={{ kind: "starting" }} thumbnail={pictureOf(B)} />);
    expect(snapshot()).toHaveAttribute("src", pictureOf(B).src);
  });

  it("never holds one project's frame up while another's loads", () => {
    vi.useFakeTimers();
    try {
      const { rerender } = render(
        <PreviewPane projectId={A} phase={running("https://5173-alpha.e2b.dev", 2)} />,
      );
      fireEvent.load(frame() as HTMLElement);

      rerender(<PreviewPane projectId={B} phase={running("https://5173-beta.e2b.dev", 2)} />);

      expect(
        screen
          .queryAllByTitle(PREVIEW_TITLE)
          .filter((node) => node.getAttribute("src")?.includes("alpha")),
      ).toHaveLength(0);
      act(() => vi.advanceTimersByTime(SWAP_TIMEOUT_MS));
      expect(
        screen
          .queryAllByTitle(PREVIEW_TITLE)
          .filter((node) => node.getAttribute("src")?.includes("alpha")),
      ).toHaveLength(0);
      expect(frame()).toHaveAttribute("src", "https://5173-beta.e2b.dev");
    } finally {
      vi.useRealTimers();
    }
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
