/**
 * The part of the card that needs a browser: *when* it is worked out, and when it stops being
 * shown.
 *
 * The rule itself is `unseen-summary.test.ts`'s. What is checked here is the freeze — that the card
 * describes the log as it stood when reading resumed, and does not grow a new sentence every time
 * a job concludes in front of somebody who is sitting there watching it.
 */

import type { StoredEvent } from "@nap/shared/ports/event-store";
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { check, JOB_ID as JOB, jobLog, OTHER_JOB_ID as OTHER_JOB } from "../testing/job-events.ts";
import { useUnseenCard } from "./use-unseen-card.ts";

let log = jobLog();

beforeEach(() => {
  log = jobLog();
});

function concluded(jobId: string, objective: string): StoredEvent[] {
  return [
    log.opened(jobId, objective),
    log.committed("abc12345678"),
    log.verified([check("typecheck", "passed")], jobId),
    log.checkpointed("abc12345678", jobId),
    log.at("job.completed", { jobId, outcome: "verified" }),
  ];
}

/** A pane that has replayed a log and knows where its reader left off. */
function open(events: StoredEvent[], seen: number | undefined, replayed = true) {
  return renderHook((props) => useUnseenCard(props.events, props.seen, props.replayed), {
    initialProps: { events, seen, replayed },
  });
}

describe("when it is worked out", () => {
  it("describes the log as it stood when reading resumed", () => {
    const events = concluded(JOB, "build a todo list");

    const { result } = open(events, events[0]?.seq);

    expect(result.current.card?.objective).toBe("build a todo list");
  });

  it("waits for the log to arrive before deciding there is nothing to say", () => {
    // Events replay one at a time and `ready` comes last, so a card worked out on the first
    // frame would be a card worked out over an empty log — and, frozen, it would then never
    // fire for a session where something plainly did happen.
    const events = concluded(JOB, "build a todo list");
    const view = open([], 1, false);

    expect(view.result.current.card).toBeNull();

    view.rerender({ events, seen: 1, replayed: true });

    expect(view.result.current.card?.objective).toBe("build a todo list");
  });

  it("says nothing about a job that concluded while you sat and watched it", () => {
    // The seam does not move while somebody reads, so everything arriving now is technically
    // below it. That is right for a marker and wrong for a card: "while you were away" about
    // the turn somebody just watched finish is the interface not knowing where they are.
    const view = open([], 0);

    act(() => {
      view.rerender({ events: concluded(JOB, "build a todo list"), seen: 0, replayed: true });
    });

    expect(view.result.current.card).toBeNull();
  });

  it("works it out again on a return where the cursor did not move", () => {
    // The case the whole feature exists for, and the one a dependency on the seam's *value*
    // silently drops: a tab that was up to date when it was hidden comes back to a cursor
    // holding the number it already held, so nothing about `seen` changes — while a job
    // concluded in the meantime, on a socket that stayed open.
    const view = open([], 4);
    view.rerender({ events: concluded(JOB, "build a todo list"), seen: 4, replayed: true });
    expect(view.result.current.card).toBeNull();

    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });

    expect(view.result.current.card?.objective).toBe("build a todo list");
  });

  it("works it out again when the reader comes back to the tab", () => {
    // Returning to a background tab re-reads the seen cursor, so a new seam arrives — and what
    // arrived while it was hidden is exactly what this is for.
    const view = open([], 0);
    const events = concluded(OTHER_JOB, "add a dark mode toggle");
    view.rerender({ events, seen: 0, replayed: true });

    act(() => {
      view.rerender({ events, seen: events[0]?.seq, replayed: true });
    });

    expect(view.result.current.card?.objective).toBe("add a dark mode toggle");
  });
});

describe("dismissing it", () => {
  it("takes the card away and does not bring it back on the next event", () => {
    const events = concluded(JOB, "build a todo list");
    const view = open(events, events[0]?.seq);

    act(() => {
      view.result.current.dismiss();
    });
    view.rerender({
      events: [...events, log.at("agent.message", { text: "Anything else?" })],
      seen: events[0]?.seq,
      replayed: true,
    });

    expect(view.result.current.card).toBeNull();
  });
});
