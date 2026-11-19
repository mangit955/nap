import { describe, expect, it } from "vitest";
import type { PreviewState } from "../preview/preview-state.ts";
import { type PhaseInputs, phaseOf } from "./project-phase.ts";

/**
 * The four states a person can see, and which one wins when two sources disagree.
 *
 * Most of these are frames a component test cannot reach, because rendering flushes effects inside
 * the same `act`. They occur in a browser, and the bug this file was written for was found that
 * way: a running project announcing that nothing was running for the two seconds before its log
 * arrived.
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
    ...overrides,
  };
}

describe("before anything is known", () => {
  it("recognizes a ready repository without waiting for a preview", () => {
    expect(
      phaseOf(inputs({ previewRequired: false, preview: { status: "starting", since: NOON } })),
    ).toEqual({
      kind: "no-preview",
    });
  });

  it("shows why a repository without a preview failed to start instead of starting forever", () => {
    expect(
      phaseOf(
        inputs({
          previewRequired: false,
          record: "new",
          preview: { status: "error", message: "Repository setup failed." },
        }),
      ),
    ).toEqual({ kind: "failed", message: "Repository setup failed." });
    expect(
      phaseOf(inputs({ previewRequired: false, record: "new", preview: { status: "idle" } })).kind,
    ).toBe("starting");
  });

  it("stops claiming to start when the first turn was stopped before it had a sandbox", () => {
    // The log has nothing further to say, so anything waiting on it would wait for ever.
    const preview: PreviewState = { status: "cancelled" };

    expect(phaseOf(inputs({ record: "new", preview })).kind).toBe("idle");
    expect(phaseOf(inputs({ previewRequired: false, record: "new", preview })).kind).toBe("idle");
  });

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

  it("is put away, not starting, when the project is opened and nothing has been asked for", () => {
    // Opening a project starts nothing. A put-away record with no request in flight is the
    // put-away screen and its Resume button, not a wait for a start nobody asked for.
    const phase = phaseOf(inputs({ putAwayAt: NOON, preview: { status: "stopped" } }));

    expect(phase.kind).toBe("put-away");
  });

  it("is starting once a message newer than the put-away record has been sent", () => {
    // Sending is one of the two ways to start a put-away project, and the turn restores the
    // sandbox itself. The record still says put away until something re-reads it, so without the
    // comparison the pane would offer Resume for a start that is already under way.
    const phase = phaseOf(
      inputs({ putAwayAt: NOON, preview: { status: "starting", since: LATER } }),
    );

    expect(phase.kind).toBe("starting");
  });

  it("stays put away when the log's last message is older than the record", () => {
    // A turn from before the sandbox was reclaimed says nothing about now.
    const phase = phaseOf(
      inputs({ putAwayAt: NOON, preview: { status: "starting", since: EARLIER } }),
    );

    expect(phase.kind).toBe("put-away");
  });

  it("is starting when the log says a turn is working on the first preview", () => {
    expect(
      phaseOf(inputs({ record: "new", preview: { status: "starting", since: NOON } })).kind,
    ).toBe("starting");
  });
});

describe("the record against the log", () => {
  it("keeps trusting the record about an announcement older than it", () => {
    // Nothing announces a sandbox the provider reclaimed on its own timer, so the newest event in
    // the log can be an address that stopped answering an hour ago.
    const phase = phaseOf(inputs({ putAwayAt: NOON, preview: ready(EARLIER) }));

    expect(phase.kind).toBe("put-away");
  });

  it("believes an announcement made after the record was read", () => {
    // A project's first turn creates a sandbox seconds after the workspace opened, and the record
    // read at mount said there was none. It was right then and is wrong now.
    const phase = phaseOf(inputs({ putAwayAt: NOON, preview: ready(LATER) }));

    expect(phase).toMatchObject({ kind: "running", url: "https://5173-abc.e2b.app", seq: 7 });
  });

  it("is put away when the log itself says a sandbox went", () => {
    // A close in another tab announces itself, and the record this page holds still says a sandbox
    // is running.
    expect(phaseOf(inputs({ preview: { status: "stopped" } })).kind).toBe("put-away");
  });

  it("is put away when the record says so and nothing has ever been announced", () => {
    const phase = phaseOf(inputs({ putAwayAt: NOON, preview: { status: "idle" } }));

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
