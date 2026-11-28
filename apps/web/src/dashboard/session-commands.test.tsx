import { NavigationSchema, type SessionSummary } from "@nap/shared/session-navigation";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { sessionCommands } from "./session-commands.tsx";

const NOW = Date.parse("2026-10-23T12:00:00.000Z");
const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();

function session(
  id: string,
  over: Partial<SessionSummary> = {},
  nav: Partial<SessionSummary["navigation"]> = {},
): SessionSummary {
  return {
    projectId: id,
    name: `Session ${id}`,
    status: "ready",
    sandboxId: null,
    sessionIds: [],
    createdAt: at(600),
    updatedAt: at(600),
    navigation: NavigationSchema.parse(nav),
    revision: 0,
    activity: "ready",
    activityAt: null,
    requestedAt: null,
    repository: null,
    branch: null,
    pullRequest: null,
    pendingFeedback: 0,
    runStartedAt: null,
    turnFinishedAt: null,
    diff: null,
    model: null,
    titling: false,
    ...over,
  };
}

describe("sessionCommands", () => {
  it("lists sessions in the sidebar's shelf order and leaves archived ones out", () => {
    const rows = [
      session("settled", {}, { doneAt: at(5) }),
      session("archived", {}, { archivedAt: at(1) }),
      session("active", { requestedAt: at(30) }),
      session("pinned", {}, { pinned: true }),
    ];
    expect(sessionCommands(rows, NOW, () => {}).map((command) => command.id)).toEqual([
      "session:pinned",
      "session:active",
      "session:settled",
    ]);
  });

  it("opens the session it names", () => {
    const open = vi.fn();
    sessionCommands([session("a"), session("b", {}, { pinned: true })], NOW, open)[1]?.run();
    expect(open).toHaveBeenCalledWith("a");
  });

  it("says Working for a running session and a compact time otherwise", () => {
    const [running, idle] = sessionCommands(
      [
        session("running", { activity: "working", requestedAt: at(1) }),
        session("idle", { requestedAt: at(120) }),
      ],
      NOW,
      () => {},
    );
    render(
      <>
        {running?.meta}|{idle?.meta}
      </>,
    );
    expect(screen.getByText("Working")).toBeTruthy();
    expect(screen.getByText("2h", { exact: false })).toBeTruthy();
  });
});
