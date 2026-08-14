import { describe, expect, it } from "vitest";
import type { PreviewState } from "../preview/preview-state.ts";
import { type PhaseInputs, phaseOf } from "./project-phase.ts";

/**
 * The four states a person can see, and which one wins when two sources disagree.
 *
 * Most of these are frames a component test cannot reach: rendering flushes effects inside the
 * same `act`, so the gap between a paint and the effect that starts a project never occurs there.
 * It occurs in a browser on every single open, and both bugs this file pins were found that way —
 * the put-away screen flashing on the way in, and a running project announcing that nothing was
 * running for the two seconds before its log arrived.
 */

const NOON = "2026-08-09T12:00:00.000Z";
const EARLIER = "2026-08-09T11:00:00.000Z";
const LATER = "2026-08-09T13:00:00.000Z";

const ready = (createdAt: string): PreviewState => ({
  status: "ready",
  url: "https://5173-abc.e2b.app",
  port: 5173,
  seq: 7,
  createdAt,
});

/** A project that is running and whose log has arrived — the ordinary case. */
function inputs(overrides: Partial<PhaseInputs> = {}): PhaseInputs {
  return {
    status: "ready",
    record: "running",
    putAwayAt: undefined,
    preview: ready(NOON),
    replayed: true,
    resuming: false,
    resumeError: undefined,
    ...overrides,
  };
}

describe("before anything is known", () => {
  it("is opening while the record is still being fetched", () => {
    // Nothing is known yet, and deriving a state from an empty log is how the pane came to
    // announce "Nothing running yet" about a project that was running.
    expect(phaseOf(inputs({ status: "loading" })).kind).toBe("opening");
  });

  it("is opening while the log of a running project is still arriving", () => {
    // The two-second lie, measured in a real browser: the record says a sandbox is serving, and
    // the announcement naming its address is still in flight. There is nothing to point an iframe
    // at yet and nothing to invite either, so the honest answer is a wait.
    const phase = phaseOf(inputs({ replayed: false, preview: { status: "idle" } }));

    expect(phase.kind).toBe("opening");
  });

  it("invites a first prompt for a project that has never run, log or no log", () => {
    // A new project has nothing to wait for. Waiting at it would be the same lie in reverse.
    expect(
      phaseOf(inputs({ record: "new", replayed: false, preview: { status: "idle" } })).kind,
    ).toBe("idle");
  });
});

describe("a start that is under way", () => {
  it("is starting while the request is in flight", () => {
    expect(phaseOf(inputs({ resuming: true, preview: { status: "stopped" } })).kind).toBe(
      "starting",
    );
  });

  it("is starting in the gap between the record and the request", () => {
    // The clause that fixes the flash: the record says the project is not running, nothing has
    // refused to start it, and the effect that will start it has not run yet. Without this the
    // pane draws the whole put-away screen — button and all — offering to do the thing that is
    // already being done.
    const phase = phaseOf(inputs({ putAwayAt: NOON, preview: { status: "stopped" } }));

    expect(phase.kind).toBe("starting");
  });

  it("stops claiming to be starting once a start has been refused", () => {
    // Otherwise the pane claims forever to be starting a project that nothing is starting, and
    // hides the one screen carrying the button that could fix it.
    const phase = phaseOf(
      inputs({
        putAwayAt: NOON,
        preview: { status: "stopped" },
        resumeError: "You already have 2 projects running.",
      }),
    );

    expect(phase.kind).toBe("put-away");
  });

  it("is starting when the log says a turn is working on the first preview", () => {
    expect(phaseOf(inputs({ record: "new", preview: { status: "starting" } })).kind).toBe(
      "starting",
    );
  });
});

describe("the record against the log", () => {
  it("keeps trusting the record about an announcement older than it", () => {
    // Nothing announces a sandbox the provider reclaimed on its own timer, so the newest event in
    // the log can be an address that stopped answering an hour ago.
    const phase = phaseOf(inputs({ putAwayAt: NOON, preview: ready(EARLIER), resumeError: "no" }));

    expect(phase.kind).toBe("put-away");
  });

  it("believes an announcement made after the record was read", () => {
    // A project's first turn creates a sandbox seconds after the workspace opened, and the record
    // read at mount said there was none. It was right then and is wrong now.
    const phase = phaseOf(inputs({ putAwayAt: NOON, preview: ready(LATER), resumeError: "no" }));

    expect(phase).toMatchObject({ kind: "running", url: "https://5173-abc.e2b.app", seq: 7 });
  });

  it("is put away when the log itself says a sandbox went", () => {
    // A close in another tab announces itself, and the record this page holds still says a sandbox
    // is running.
    expect(phaseOf(inputs({ preview: { status: "stopped" } })).kind).toBe("put-away");
  });

  it("is put away when the record says so and nothing has ever been announced", () => {
    const phase = phaseOf(
      inputs({ putAwayAt: NOON, preview: { status: "idle" }, resumeError: "no" }),
    );

    expect(phase.kind).toBe("put-away");
  });
});

describe("what the log has to say", () => {
  it("is running, and carries the address and the announcement that named it", () => {
    // The `seq` travels with it because a reload keys on it: a project put away and restarted has
    // two announcements in its log and only one live sandbox.
    expect(phaseOf(inputs())).toMatchObject({
      kind: "running",
      url: "https://5173-abc.e2b.app",
      seq: 7,
    });
  });

  it("has failed when the log says the sandbox could not be had", () => {
    const phase = phaseOf(
      inputs({ record: "new", preview: { status: "error", message: "no capacity" } }),
    );

    expect(phase).toMatchObject({ kind: "failed", message: "no capacity" });
  });

  it("says nothing has run yet when the log is empty and the record has no objection", () => {
    expect(phaseOf(inputs({ record: "new", preview: { status: "idle" } })).kind).toBe("idle");
  });

  it("shows a deleted project as nothing rather than as a wait", () => {
    // The header carries the real sentence — "this project no longer exists" — and a pane spinning
    // forever underneath it would contradict it.
    expect(phaseOf(inputs({ status: "missing", record: undefined })).kind).toBe("idle");
  });

  it("keeps showing a running app when the record fetch is the thing that failed", () => {
    // The record and the log fail independently. A background request going wrong is no reason to
    // take away the app somebody is watching — the header admits the server is unreachable, and
    // `preview-state.ts` states the same rule for a turn that fails under a live preview.
    expect(phaseOf(inputs({ status: "error", record: undefined })).kind).toBe("running");
  });
});
