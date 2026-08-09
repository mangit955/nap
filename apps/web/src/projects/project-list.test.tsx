import type { ProjectSummaryPayload } from "@nap/shared/projects-protocol";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ProjectList, relativeTime } from "./project-list.tsx";

const PROJECT = "3e0fbc41-6f5d-4a8e-ab9c-4d5e6f708192";
const OTHER = "6b7c8d9e-0f1a-4b2c-8d3e-4f5a6b7c8d9e";
const SESSION = "2a3f8a24-6c1b-4e0e-9b6f-3a5c0a1d9e77";

function summary(overrides: Partial<ProjectSummaryPayload> = {}): ProjectSummaryPayload {
  return {
    projectId: PROJECT,
    name: "Todo app",
    status: "ready",
    sandboxId: "sbx_live",
    updatedAt: new Date().toISOString(),
    sessionIds: [SESSION],
    ...overrides,
  };
}

function show(props: Partial<Parameters<typeof ProjectList>[0]> = {}) {
  const handlers = {
    onCreate: vi.fn(),
    onOpen: vi.fn(),
    onClose: vi.fn(),
    onDelete: vi.fn(),
  };
  render(
    <ProjectList
      projects={[summary()]}
      status="ready"
      actionError={undefined}
      {...handlers}
      {...props}
    />,
  );
  return handlers;
}

describe("the list itself", () => {
  it("names each project and offers a way in", () => {
    const { onOpen } = show();

    fireEvent.click(screen.getByRole("button", { name: "Todo app" }));

    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ projectId: PROJECT }));
  });

  it("keeps the order it was given", () => {
    // The hook hands back what the server sorted; re-sorting here would be a second opinion
    // about "most recent", and the two would disagree the first time one of them changed.
    show({
      projects: [
        summary({ projectId: PROJECT, name: "Newest" }),
        summary({ projectId: OTHER, name: "Older" }),
      ],
    });

    const names = screen.getAllByRole("listitem").map((item) => item.textContent);
    expect(names[0]).toContain("Newest");
    expect(names[1]).toContain("Older");
  });

  it("says what state a project is in, in words", () => {
    // Not a colour: a dot says nothing to a screen reader and the wrong thing to anyone who
    // cannot separate two hues.
    show({ projects: [summary({ sandboxId: null, status: "idle" })] });

    expect(screen.getByRole("listitem")).toHaveTextContent(/put away/i);
  });
});

describe("when there is nothing to show", () => {
  it("says the list is empty rather than showing a blank page", () => {
    show({ projects: [], status: "ready" });

    expect(screen.getByText(/nothing here yet/i)).toBeInTheDocument();
  });

  it("tells the difference between empty and broken", () => {
    // "You have no projects" and "the server is down" are different sentences, and showing the
    // first when the second is true invites a second click on New project.
    show({ projects: [], status: "error" });

    expect(screen.getByText(/could not reach the server/i)).toBeInTheDocument();
    expect(screen.queryByText(/nothing here yet/i)).not.toBeInTheDocument();
  });

  it("says it is still loading before the first answer", () => {
    show({ projects: [], status: "loading" });

    expect(screen.getByText(/loading your projects/i)).toBeInTheDocument();
  });
});

describe("creating", () => {
  it("asks for a new project", () => {
    const { onCreate } = show();

    fireEvent.click(screen.getByRole("button", { name: /new project/i }));

    expect(onCreate).toHaveBeenCalledOnce();
  });
});

describe("closing", () => {
  it("offers to put away a project that is running", () => {
    const { onClose } = show();

    fireEvent.click(screen.getByRole("button", { name: /^close$/i }));

    expect(onClose).toHaveBeenCalledWith(PROJECT);
  });

  it("offers nothing to close on a project that is already put away", () => {
    // There is no sandbox to snapshot, so the button would be a request the server refuses to
    // treat as an action.
    show({ projects: [summary({ sandboxId: null, status: "idle" })] });

    expect(screen.queryByRole("button", { name: /^close$/i })).not.toBeInTheDocument();
  });
});

describe("deleting", () => {
  it("asks before doing anything", () => {
    // The one action here that cannot be undone: the bytes go too, and there is no snapshot
    // left to open afterwards.
    const { onDelete } = show();

    fireEvent.click(screen.getByRole("button", { name: /^delete$/i }));

    expect(onDelete).not.toHaveBeenCalled();
    expect(screen.getByText(/delete for good/i)).toBeInTheDocument();
  });

  it("deletes once it has been confirmed", () => {
    const { onDelete } = show();

    fireEvent.click(screen.getByRole("button", { name: /^delete$/i }));
    fireEvent.click(screen.getByRole("button", { name: /yes, delete/i }));

    expect(onDelete).toHaveBeenCalledWith(PROJECT);
  });

  it("can be backed out of", () => {
    const { onDelete } = show();

    fireEvent.click(screen.getByRole("button", { name: /^delete$/i }));
    fireEvent.click(screen.getByRole("button", { name: /keep/i }));

    expect(onDelete).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /^delete$/i })).toBeInTheDocument();
  });

  it("confirms one project at a time", () => {
    // A confirmation that applied to every row would put "Yes, delete" next to a project the
    // user never pointed at.
    show({
      projects: [summary({ projectId: PROJECT }), summary({ projectId: OTHER, name: "Other" })],
    });

    fireEvent.click(screen.getAllByRole("button", { name: /^delete$/i })[0] as HTMLElement);

    expect(screen.getAllByRole("button", { name: /yes, delete/i })).toHaveLength(1);
  });
});

describe("while an action is running", () => {
  it("stops the row being pressed twice", () => {
    const { onClose } = show({ busyProjectId: PROJECT });

    const close = screen.getByRole("button", { name: /^close$/i });
    expect(close).toBeDisabled();
    fireEvent.click(close);

    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("reporting a refusal", () => {
  it("announces what the server said", () => {
    // `alert`, because this appears in response to a press and a message that only changes
    // visually is one a screen reader never mentions.
    show({ actionError: "Could not delete the project — a turn is running in this project." });

    expect(screen.getByRole("alert")).toHaveTextContent(/a turn is running/);
  });
});

describe("relativeTime", () => {
  const NOW = Date.parse("2026-08-09T12:00:00.000Z");

  it.each([
    ["2026-08-09T11:59:30.000Z", "just now"],
    ["2026-08-09T11:30:00.000Z", "30m ago"],
    ["2026-08-09T09:00:00.000Z", "3h ago"],
    ["2026-08-07T12:00:00.000Z", "2d ago"],
  ])("renders %s as %s", (iso, expected) => {
    expect(relativeTime(iso, NOW)).toBe(expected);
  });

  it("never renders a negative age", () => {
    // Clocks disagree: a row written by a server a second ahead would otherwise read "-1m ago".
    expect(relativeTime("2026-08-09T12:00:30.000Z", NOW)).toBe("just now");
  });
});
