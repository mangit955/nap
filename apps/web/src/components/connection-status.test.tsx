import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { StreamStatus } from "../hooks/use-event-stream.ts";
import { ConnectionStatus, STATUS_LABELS } from "./connection-status.tsx";

/**
 * Queried by role and accessible name, never by class name — a coloured dot with no name is
 * invisible to a screen reader, and "the connection dropped" is exactly the kind of thing a
 * user must not have to see a colour to learn.
 */

const STATUSES = ["idle", "connecting", "open", "reconnecting"] as const satisfies StreamStatus[];

describe("ConnectionStatus", () => {
  it("gives every status a distinct, readable label", () => {
    const labels = STATUSES.map((status) => STATUS_LABELS[status]);

    expect(new Set(labels).size).toBe(labels.length);
    for (const label of labels) expect(label.length).toBeGreaterThan(0);
  });

  it.each(STATUSES)("announces %s", (status) => {
    render(<ConnectionStatus status={status} />);

    expect(screen.getByRole("status")).toHaveTextContent(STATUS_LABELS[status]);
  });

  it("keeps the label in the accessibility tree rather than in a colour", () => {
    // A live region, so a drop is announced when it happens instead of only being visible.
    render(<ConnectionStatus status="reconnecting" />);

    const region = screen.getByRole("status");
    expect(region).toHaveAttribute("aria-live");
    expect(region.textContent).not.toBe("");
  });

  it("does not claim to be connected before there is a session", () => {
    render(<ConnectionStatus status="idle" />);

    expect(screen.getByRole("status")).not.toHaveTextContent(STATUS_LABELS.open);
  });
});
