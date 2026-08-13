import type { ProjectSummaryPayload } from "@nap/shared/projects-protocol";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ProjectCard } from "./project-card.tsx";

/**
 * The tile: a picture of the app, over the colour that stands in until there is one.
 *
 * These query the `img` element directly, which is the deliberate exception to the
 * query-by-role rule — a decorative screenshot has no accessible surface at all, exactly like
 * the syntax highlighting in the code pane. What a reader gets from this card is the "Open
 * {name}" button, and that is asserted by role below.
 */

const PROJECT: ProjectSummaryPayload = {
  projectId: "3e0fbc41-6f5d-4a8e-ab9c-4d5e6f708192",
  name: "Todo app",
  status: "ready",
  sandboxId: null,
  updatedAt: "2026-08-09T11:00:00.000Z",
  sessionIds: ["2a3f8a24-6c1b-4e0e-9b6f-3a5c0a1d9e77"],
};

function show(project: ProjectSummaryPayload = PROJECT) {
  const { container } = render(
    <ProjectCard project={project} onOpen={() => {}} onClose={() => {}} onDelete={() => {}} />,
  );
  return container;
}

describe("the tile", () => {
  it("shows the project's own picture", () => {
    const image = show().querySelector("img");

    expect(image?.getAttribute("src")).toContain(`/projects/${PROJECT.projectId}/thumbnail`);
  });

  it("sends the session cookie with it", () => {
    // The API is another origin and the route asks who is calling; without this the request
    // arrives unauthenticated and every card 401s, which looks exactly like having no pictures.
    expect(show().querySelector("img")?.getAttribute("crossorigin")).toBe("use-credentials");
  });

  it("says nothing to a screen reader", () => {
    // The card is already named by its Open button. A second announcement of the same project
    // is noise, and there is nothing useful to say about a screenshot anyway.
    expect(show().querySelector("img")?.getAttribute("alt")).toBe("");
  });

  it("falls back to the colour when there is no picture", () => {
    // The ordinary state of a project that has never finished a turn. A card must not sprout a
    // broken-image icon because nobody has photographed it yet.
    const container = show();
    const image = container.querySelector("img");
    expect(image).not.toBeNull();

    if (image !== null) fireEvent.error(image);

    expect(container.querySelector("img")).toBeNull();
  });

  it("still opens the project", () => {
    show();

    expect(screen.getByRole("button", { name: /open todo app/i })).toBeInTheDocument();
  });
});
