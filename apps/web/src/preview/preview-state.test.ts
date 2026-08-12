import type { NapEvent, NapEventType } from "@nap/shared/events";
import type { StoredEvent } from "@nap/shared/ports/event-store";
import { describe, expect, it } from "vitest";
import { isPutAway, previewState } from "./preview-state.ts";

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

function state(...events: StoredEvent[]) {
  nextSeq = 1;
  return previewState(events);
}

const ready = (url = "https://5173-abc.e2b.dev") => ev("preview.ready", { url, port: 5173 });
const completed = () =>
  ev("turn.completed", {
    usage: { inputTokens: 1, outputTokens: 2 },
    durationMs: 100,
    commitSha: null,
  });

describe("before anything has happened", () => {
  it("is idle", () => {
    expect(state()).toMatchObject({ status: "idle" });
  });
});

describe("while a turn is running", () => {
  it("is starting once a turn opens with no preview yet", () => {
    expect(state(ev("user.message", { text: "build me a todo list" }))).toMatchObject({
      status: "starting",
    });
  });

  it("stays starting through the turn's other events", () => {
    expect(
      state(
        ev("user.message", { text: "go" }),
        ev("turn.started", {}),
        ev("agent.message", { text: "working" }),
      ),
    ).toMatchObject({ status: "starting" });
  });
});

describe("once the sandbox is serving", () => {
  it("is ready, carrying the address and the port", () => {
    expect(state(ev("user.message", { text: "go" }), ready())).toMatchObject({
      status: "ready",
      url: "https://5173-abc.e2b.dev",
      port: 5173,
    });
  });

  it("follows the newest preview when the sandbox is replaced", () => {
    const result = state(ready("https://old.e2b.dev"), ready("https://new.e2b.dev"));

    expect(result).toMatchObject({ status: "ready", url: "https://new.e2b.dev" });
  });

  it("identifies the preview by the event that announced it", () => {
    // What the iframe is keyed on: a new announcement has to be distinguishable from the
    // same one arriving again, or a restarted dev server never gets reloaded.
    const first = state(ready("https://same.e2b.dev"));
    const second = state(ready("https://same.e2b.dev"), ready("https://same.e2b.dev"));

    expect(first.status === "ready" && second.status === "ready").toBe(true);
    if (first.status !== "ready" || second.status !== "ready") return;
    expect(second.seq).toBeGreaterThan(first.seq);
  });

  it("keeps showing the app when a later turn fails", () => {
    // The app is still running; a failed turn does not take it away. Blanking the pane here
    // would throw away the thing the user is looking at over an error in the chat.
    const result = state(
      ready(),
      completed(),
      ev("user.message", { text: "now break it" }),
      ev("turn.failed", { reason: "internal", message: "boom" }),
    );

    expect(result).toMatchObject({ status: "ready" });
  });
});

describe("once the project has been put away", () => {
  it("stops showing an app that is no longer being served", () => {
    // The address in the last `preview.ready` belongs to a sandbox that has been destroyed.
    // Left ready, the frame renders the provider's "not found" page as if it were the app.
    const result = state(ready(), completed(), ev("preview.stopped", {}));

    expect(result).toMatchObject({ status: "stopped" });
  });

  it("comes back when the project is started up again", () => {
    const result = state(ready("https://old.e2b.dev"), ev("preview.stopped", {}), ready());

    expect(result).toMatchObject({ status: "ready", url: "https://5173-abc.e2b.dev" });
  });

  it("says it is starting when a message is sent instead of pressing resume", () => {
    // Sending a message restores the project too. The pane should say so rather than keep
    // offering a button for something already under way.
    const result = state(ready(), ev("preview.stopped", {}), ev("user.message", { text: "go" }));

    expect(result).toMatchObject({ status: "starting" });
  });
});

describe("when the sandbox never came up", () => {
  it("reports the failure with what went wrong", () => {
    const result = state(
      ev("user.message", { text: "go" }),
      ev("turn.failed", { reason: "sandbox_unavailable", message: "no capacity" }),
    );

    expect(result).toMatchObject({ status: "error", message: "no capacity" });
  });

  it("treats an internal failure with no preview as a preview failure too", () => {
    // Whatever broke, the user is looking at an empty pane and needs to know why.
    expect(state(ev("turn.failed", { reason: "internal", message: "unhandled" }))).toMatchObject({
      status: "error",
    });
  });

  it.each(["budget_exceeded", "refusal", "cancelled"] as const)(
    "does not blame the preview for a %s failure",
    (reason) => {
      // These are the agent giving up, not the sandbox failing to boot. The chat explains
      // them; the preview pane claiming the sandbox died would be a lie.
      const result = state(
        ev("user.message", { text: "go" }),
        ev("turn.failed", { reason, message: "nope" }),
      );

      expect(result.status).not.toBe("error");
    },
  );

  it("clears the error once a later turn starts", () => {
    const result = state(
      ev("turn.failed", { reason: "sandbox_unavailable", message: "no capacity" }),
      ev("user.message", { text: "try again" }),
    );

    expect(result).toMatchObject({ status: "starting" });
  });
});

describe("the record against the log", () => {
  const at = (createdAt: string) =>
    ev("preview.ready", { url: "https://5173-abc.e2b.dev", port: 5173 }, createdAt);

  const NOON = "2026-08-09T12:00:00.000Z";
  const EARLIER = "2026-08-09T11:00:00.000Z";
  const LATER = "2026-08-09T13:00:00.000Z";

  it("keeps trusting the record about an announcement older than it", () => {
    // The case the override exists for: nothing announces a sandbox the provider reclaimed on
    // its own timer, so the newest event in the log can be an address that stopped answering an
    // hour ago.
    expect(isPutAway([at(EARLIER)], NOON)).toBe(true);
  });

  it("believes an announcement made after the record was read", () => {
    // The defect: a project's first turn creates a sandbox seconds after the workspace opened,
    // and the record read at mount said there was none. It was right then and is wrong now.
    expect(isPutAway([at(LATER)], NOON)).toBe(false);
  });

  it("takes the log's word for it when the record has no objection", () => {
    expect(isPutAway([at(NOON)], undefined)).toBe(false);
  });

  it("is put away when the log itself says a sandbox went", () => {
    // A close in another tab announces itself, and the record this page holds still says a
    // sandbox is running.
    expect(isPutAway([at(EARLIER), ev("preview.stopped", {})], undefined)).toBe(true);
  });

  it("is put away when the record says so and nothing has ever been announced", () => {
    expect(isPutAway([], NOON)).toBe(true);
    expect(isPutAway([], undefined)).toBe(false);
  });
});
