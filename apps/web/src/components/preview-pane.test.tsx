import type { NapEvent, NapEventType } from "@nap/shared/events";
import type { StoredEvent } from "@nap/shared/ports/event-store";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PREVIEW_TITLE, PreviewPane } from "./preview-pane.tsx";

const SESSION = "0b7f8f1e-3c2a-4d5b-9e6f-1a2b3c4d5e6f";
const TURN = "7c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f";

let nextSeq = 1;

function ev<T extends NapEventType>(
  type: T,
  payload: Extract<NapEvent, { type: T }>["payload"],
  createdAt = "2026-08-09T12:00:00.000Z",
) {
  return {
    type,
    sessionId: SESSION,
    turnId: TURN,
    seq: nextSeq++,
    createdAt,
    payload,
  } as StoredEvent;
}

function show(...events: StoredEvent[]) {
  nextSeq = 1;
  return render(<PreviewPane events={events} />);
}

const asked = () => ev("user.message", { text: "build me a todo list" });
const ready = (url = "https://5173-abc.e2b.dev") => ev("preview.ready", { url, port: 5173 });

/** The iframe, or `null` — its identity is what a hard reload changes. */
const frame = () => screen.queryByTitle(PREVIEW_TITLE);

describe("the four states", () => {
  it("invites a first prompt before anything has been asked for", () => {
    show();

    expect(screen.getByText(/describe an app/i)).toBeVisible();
    expect(frame()).toBeNull();
  });

  it("says the app is starting while the sandbox comes up", () => {
    // Not a bare spinner: the user should know what is being waited on, and that it is
    // expected to take a moment rather than being stuck.
    show(asked());

    expect(screen.getByText(/starting/i)).toBeVisible();
    expect(frame()).toBeNull();
  });

  it("shows the app once the sandbox is serving", () => {
    show(asked(), ready());

    expect(frame()).toHaveAttribute("src", "https://5173-abc.e2b.dev");
  });

  it("says what failed and what to do about it", () => {
    show(asked(), ev("turn.failed", { reason: "sandbox_unavailable", message: "no capacity" }));

    // The reason in the interface's own words, the detail underneath, and an action — a bare
    // "something went wrong" leaves the user with nothing to do but reload the page.
    //
    // The exact wording now comes from `failure-copy.ts`, which the transcript reads too: this
    // pane used to phrase the same `turn.failed` differently, so one failure looked like two
    // problems depending on which half of the screen you were looking at.
    expect(screen.getByText(/couldn't start/i)).toBeVisible();
    expect(screen.getByText(/no capacity/)).toBeVisible();
    expect(screen.getByText(/send the message again/i)).toBeVisible();
  });
});

describe("a project that has been put away", () => {
  const stopped = () => ev("preview.stopped", {});

  it("takes the dead app off the screen and offers the way back", () => {
    // The address in the log belongs to a sandbox that no longer exists. Left in the frame it
    // renders the provider's "not found" page, which reads as the product being broken.
    show(asked(), ready(), stopped());

    expect(frame()).toBeNull();
    expect(screen.getByText(/put away/i)).toBeVisible();
    expect(screen.getByRole("button", { name: /resume/i })).toBeEnabled();
  });

  it("says the files are safe, because that is the question being asked", () => {
    show(asked(), ready(), stopped());

    expect(screen.getByText(/still (saved|there)/i)).toBeVisible();
  });

  it("offers no reload or open control, since there is nothing behind them", () => {
    show(asked(), ready(), stopped());

    expect(screen.queryByRole("button", { name: /reload/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /open/i })).not.toBeInTheDocument();
  });

  it("asks to be resumed exactly once per press", () => {
    const presses: number[] = [];
    render(<PreviewPane events={[asked(), ready(), stopped()]} onResume={() => presses.push(1)} />);

    fireEvent.click(screen.getByRole("button", { name: /resume/i }));

    expect(presses).toHaveLength(1);
  });

  it("says it is starting, and cannot be pressed again, while it comes back up", () => {
    render(<PreviewPane events={[asked(), ready(), stopped()]} resuming />);

    expect(screen.getByText(/starting/i)).toBeVisible();
    expect(screen.queryByRole("button", { name: /resume/i })).not.toBeInTheDocument();
  });

  it("counts how long the wait has been going on", () => {
    // The one hard fact on this screen, and what tells slow apart from stuck. The rotating word
    // above it is flavour and hidden from readers; this line is what gets announced.
    render(<PreviewPane events={[asked(), ready(), stopped()]} resuming />);

    expect(screen.getByText(/starting the dev server/i)).toHaveTextContent(/\d+s/);
  });

  it("waits with the ghost rather than a spinner", () => {
    // The wait is tens of seconds in a pane with nothing else in it. Queried by class, which is
    // the same exception the syntax-highlighting tests take: an animated mark is decoration and
    // has no accessible surface at all — the sentence beside it is what a reader gets, and that
    // is asserted above.
    const { container } = render(<PreviewPane events={[asked(), ready(), stopped()]} resuming />);

    expect(container.querySelector(".nap-loader")).toBeInTheDocument();
  });

  it("shows a refusal next to the button that caused it", () => {
    render(
      <PreviewPane
        events={[asked(), ready(), stopped()]}
        resumeError="Could not open the project — you already have 2 running."
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent(/2 running/);
    // Still offered: the fix is closing another project, and then this is what they press.
    expect(screen.getByRole("button", { name: /resume/i })).toBeInTheDocument();
  });

  it("trusts the record about an announcement made before it", () => {
    // Nothing announces a sandbox the provider reclaimed on its own timer, so a project can be
    // put away while the newest event in the log still says a preview is ready.
    render(
      <PreviewPane
        events={[
          asked(),
          ev(
            "preview.ready",
            { url: "https://5173-old.e2b.dev", port: 5173 },
            "2026-08-09T11:00:00.000Z",
          ),
        ]}
        putAwayAt="2026-08-09T12:00:00.000Z"
      />,
    );

    expect(frame()).toBeNull();
    expect(screen.getByRole("button", { name: /resume/i })).toBeInTheDocument();
  });

  it("shows a sandbox that came up after the record was read", () => {
    // The defect this exists for: the workspace reads the project once, on mount, and the first
    // turn creates a sandbox seconds later. Offering Resume for something already running is the
    // page telling somebody their app is gone while it is on screen behind the panel.
    render(
      <PreviewPane
        events={[
          asked(),
          ev(
            "preview.ready",
            { url: "https://5173-new.e2b.dev", port: 5173 },
            "2026-08-09T13:00:00.000Z",
          ),
        ]}
        putAwayAt="2026-08-09T12:00:00.000Z"
      />,
    );

    expect(frame()).toHaveAttribute("src", "https://5173-new.e2b.dev");
    expect(screen.queryByRole("button", { name: /resume/i })).toBeNull();
  });

  it("shows the app again once it is serving", () => {
    show(asked(), ready(), stopped(), ready("https://5173-new.e2b.dev"));

    expect(frame()).toHaveAttribute("src", "https://5173-new.e2b.dev");
  });
});

describe("the frame itself", () => {
  it("is sandboxed, and keeps its own origin rather than this page's", () => {
    // The previewed app is written by a model from whatever the user typed. It runs on its
    // own origin, so `allow-same-origin` grants it nothing here — but dropping `allow-scripts`
    // would stop every React app in the template from running at all.
    show(ready());

    const sandbox = frame()?.getAttribute("sandbox") ?? "";
    expect(sandbox).toContain("allow-scripts");
    expect(sandbox).toContain("allow-same-origin");
  });
});

describe("reloading", () => {
  // Fixed events, built once: `seq` is what the frame is keyed on, so fixtures that renumber
  // themselves on every call would move the key for reasons the test is not about — which is
  // exactly how both of these first passed against the wrong thing.
  const first = asked();
  const announced = ready();
  const announcedAgain = { ...ready(), seq: announced.seq + 1 } as StoredEvent;
  const said = { ...ev("agent.message", { text: "done" }), seq: announced.seq + 1 } as StoredEvent;

  it("replaces the frame when a new preview is announced", () => {
    // A cross-origin frame cannot be told to reload from this side; the only way is to throw
    // the element away and make a new one. So the test is about the node's identity.
    const { rerender } = render(<PreviewPane events={[first, announced]} />);
    const before = frame();

    rerender(<PreviewPane events={[first, announced, announcedAgain]} />);

    expect(frame()).not.toBe(before);
    expect(frame()).toBeInTheDocument();
  });

  it("keeps the same frame when nothing about the preview changed", () => {
    // The stream delivers a new array on every event; remounting on each one would reload the
    // user's app every time the agent said anything.
    const { rerender } = render(<PreviewPane events={[first, announced]} />);
    const before = frame();

    rerender(<PreviewPane events={[first, announced, said]} />);

    expect(frame()).toBe(before);
  });

  it("replaces the frame when the bar asks for a reload", () => {
    // The button lives in the workspace's top bar now — it counts, and this pane's frame is
    // keyed on the count, because a cross-origin frame cannot be told to reload any other way.
    const events = [asked(), ready()];
    const { rerender } = render(<PreviewPane events={events} reloads={0} />);
    const before = frame();

    rerender(<PreviewPane events={events} reloads={1} />);

    expect(frame()).not.toBe(before);
  });

  it("sends the frame to the page the bar names", () => {
    const events = [asked(), ready()];
    const { rerender } = render(<PreviewPane events={events} route="/" />);
    const before = frame();

    rerender(<PreviewPane events={events} route="/pricing" />);

    expect(frame()).toHaveAttribute("src", "https://5173-abc.e2b.dev/pricing");
    // A different page is a different page: the frame has to be replaced, not merely re-src'd,
    // or an app that has navigated itself since would ignore the change.
    expect(frame()).not.toBe(before);
  });

  it("offers no reload control when there is nothing to reload", () => {
    show(asked());

    expect(screen.queryByRole("button", { name: /reload/i })).not.toBeInTheDocument();
  });
});

describe("the pane itself", () => {
  it("keeps its landmark in every state", () => {
    const { rerender } = show();
    expect(screen.getByRole("region", { name: "Preview" })).toBeInTheDocument();

    rerender(<PreviewPane events={[asked(), ready()]} />);
    expect(screen.getByRole("region", { name: "Preview" })).toBeInTheDocument();
  });
});
