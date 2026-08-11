import type { NapEvent, NapEventType } from "@nap/shared/events";
import type { StoredEvent } from "@nap/shared/ports/event-store";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PREVIEW_TITLE, PreviewPane } from "./preview-pane.tsx";

const SESSION = "0b7f8f1e-3c2a-4d5b-9e6f-1a2b3c4d5e6f";
const TURN = "7c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f";

let nextSeq = 1;

function ev<T extends NapEventType>(type: T, payload: Extract<NapEvent, { type: T }>["payload"]) {
  return {
    type,
    sessionId: SESSION,
    turnId: TURN,
    seq: nextSeq++,
    createdAt: "2026-08-09T12:00:00.000Z",
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

  it("offers the app in its own tab as well", () => {
    show(ready());

    const link = screen.getByRole("link", { name: /open/i });
    expect(link).toHaveAttribute("href", "https://5173-abc.e2b.dev");
    expect(link.getAttribute("rel")).toContain("noreferrer");
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

  it("replaces the frame when asked to reload", () => {
    show(ready());
    const before = frame();

    fireEvent.click(screen.getByRole("button", { name: /reload/i }));

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

  it("names the address it is showing", () => {
    show(ready("https://5173-abc.e2b.dev"));

    expect(screen.getByRole("region", { name: "Preview" })).toHaveTextContent("5173-abc.e2b.dev");
  });
});
