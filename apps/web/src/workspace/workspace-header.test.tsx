import type { StoredEvent } from "@nap/shared/ports/event-store";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { jobView } from "../chat/job-summary.ts";
import { JOB_ID as JOB, jobLog } from "../testing/job-events.ts";
import { WorkspaceHeader } from "./workspace-header.tsx";

/**
 * The one bar across the top: what project this is, which half of the workbench is showing, and
 * the controls that belong to the running app.
 *
 * Everything here is queried by role and accessible name — a bar of icon buttons is exactly
 * where an unlabelled control hides, and it is the failure worth catching.
 */

function show(props: Partial<Parameters<typeof WorkspaceHeader>[0]> = {}) {
  const handlers = {
    onTogglePanel: vi.fn(),
  };

  render(
    <WorkspaceHeader projectName="Todo app" panelOpen={true} job={null} {...handlers} {...props} />,
  );

  return handlers;
}

/** The job the bar is describing, folded from real events rather than hand-written. */
function job(...events: StoredEvent[]) {
  return jobView(events).summary;
}

describe("where the job stands", () => {
  const log = jobLog();

  it("stays on screen when the chat is collapsed", () => {
    // Anything inside the chat pane goes with it, so hiding the chat to give the preview the
    // whole window must not delete the confidence signal.
    show({
      panelOpen: false,
      job: job(log.opened(), log.at("verification.started", { jobId: JOB })),
    });

    expect(screen.getByRole("status", { name: /job phase/i })).toHaveTextContent(/verifying/i);
  });

  it("carries the phase as a word, not as a colour alone", () => {
    show({ job: job(log.opened(), log.at("job.completed", { jobId: JOB, outcome: "verified" })) });

    expect(screen.getByRole("status", { name: /job phase/i })).toHaveTextContent(/verified/i);
  });

  it("announces the phase once, and is the only thing in the bar that announces", () => {
    show({ job: job(log.opened()) });

    expect(screen.getAllByRole("status")).toHaveLength(1);
  });

  it("keeps the live region on screen before there is a job to describe", () => {
    // Empty rather than absent: a region mounted only once it has something to say is a region
    // that misses the very first change it exists to announce.
    show({ job: null });

    expect(screen.getByRole("status", { name: /job phase/i })).toBeEmptyDOMElement();
  });
});

describe("the chat toggle", () => {
  it("says what it will do, not what is showing", () => {
    const { onTogglePanel } = show({ panelOpen: true });

    const toggle = screen.getByRole("button", { name: /hide right panel/i });
    fireEvent.click(toggle);

    expect(onTogglePanel).toHaveBeenCalled();
  });

  it("offers the way back once the chat is hidden", () => {
    show({ panelOpen: false });

    expect(screen.getByRole("button", { name: /show right panel/i })).toBeInTheDocument();
  });
});
