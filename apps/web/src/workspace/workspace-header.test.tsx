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
    onTabChange: vi.fn(),
    onReload: vi.fn(),
    onRouteChange: vi.fn(),
    onToggleChat: vi.fn(),
  };

  render(
    <WorkspaceHeader
      projectName="Todo app"
      tab="preview"
      chatOpen={true}
      route="/"
      previewUrl="https://5173-abc.e2b.app"
      job={null}
      {...handlers}
      {...props}
    />,
  );

  return handlers;
}

/** The job the bar is describing, folded from real events rather than hand-written. */
function job(...events: StoredEvent[]) {
  return jobView(events).summary;
}

describe("the workbench tabs", () => {
  it("offers both halves, and says which is showing", () => {
    show({ tab: "code" });

    expect(screen.getByRole("tab", { name: "Code" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Preview" })).toHaveAttribute("aria-selected", "false");
  });

  it("switches when one is pressed", () => {
    const { onTabChange } = show();

    fireEvent.click(screen.getByRole("tab", { name: "Code" }));

    expect(onTabChange).toHaveBeenCalledWith("code");
  });
});

describe("the app's own controls", () => {
  it("reloads the frame", () => {
    const { onReload } = show();

    fireEvent.click(screen.getByRole("button", { name: /reload/i }));

    expect(onReload).toHaveBeenCalled();
  });

  it("opens the running app in a tab of its own, at the page being shown", () => {
    show({ route: "/pricing" });

    const open = screen.getByRole("link", { name: /open/i });
    expect(open).toHaveAttribute("href", "https://5173-abc.e2b.app/pricing");
    // A model wrote what is inside that frame; it does not get this page's window.
    expect(open).toHaveAttribute("rel", expect.stringContaining("noopener"));
  });

  it("sends the frame to the page that was typed, tidied up", () => {
    const { onRouteChange } = show();

    fireEvent.change(screen.getByLabelText(/page/i), { target: { value: "pricing" } });
    fireEvent.submit(screen.getByLabelText(/page/i).closest("form") as HTMLFormElement);

    expect(onRouteChange).toHaveBeenCalledWith("/pricing");
  });

  it("offers nothing to reload or open before there is an app", () => {
    // A dead link to a sandbox that does not exist is worse than no link: it opens the
    // provider's not-found page, which reads as the product being broken.
    show({ previewUrl: undefined });

    expect(screen.queryByRole("button", { name: /reload/i })).toBeNull();
    expect(screen.queryByRole("link", { name: /open/i })).toBeNull();
  });
});

describe("where the job stands", () => {
  const log = jobLog();

  it("stays on screen when the chat is collapsed", () => {
    // The strip that otherwise carries this lives inside the chat pane, so hiding the chat to
    // give the preview the whole window used to delete the confidence signal entirely.
    show({
      chatOpen: false,
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
    const { onToggleChat } = show({ chatOpen: true });

    const toggle = screen.getByRole("button", { name: /hide chat/i });
    fireEvent.click(toggle);

    expect(onToggleChat).toHaveBeenCalled();
  });

  it("offers the way back once the chat is hidden", () => {
    show({ chatOpen: false });

    expect(screen.getByRole("button", { name: /show chat/i })).toBeInTheDocument();
  });
});
