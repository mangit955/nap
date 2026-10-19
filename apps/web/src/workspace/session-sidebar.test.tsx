import type { ProjectSummaryPayload } from "@nap/shared/projects-protocol";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PROJECT_ID, SESSION_ID } from "../testing/events.ts";

const navigate = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: navigate, replace: navigate, refresh: vi.fn() }),
}));
vi.mock("../auth/client.ts", () => ({
  authClient: {
    useSession: () => ({
      data: { user: { name: "Reader", email: "reader@example.test", isAnonymous: false } },
    }),
    signOut: vi.fn(),
  },
}));

const { SessionSidebar } = await import("./session-sidebar.tsx");
const OTHER_PROJECT = "4e0fbc41-6f5d-4a8e-ab9c-4d5e6f708192";

beforeAll(() => {
  HTMLDialogElement.prototype.showModal ??= function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close ??= function () {
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  };
});
beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function server(deleteStatus: number) {
  let projects: ProjectSummaryPayload[] = [
    {
      projectId: PROJECT_ID,
      name: "Current app",
      status: "ready",
      sandboxId: "sbx_active",
      updatedAt: "2026-08-09T12:00:00.000Z",
      sessionIds: [SESSION_ID],
    },
    {
      projectId: OTHER_PROJECT,
      name: "Other app",
      status: "ready",
      sandboxId: null,
      updatedAt: "2026-08-09T11:00:00.000Z",
      sessionIds: [],
    },
  ];
  const deleted: string[] = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    if (path === "/projects") return Response.json({ projects });
    if (init?.method === "DELETE") {
      deleted.push(path);
      if (deleteStatus !== 200)
        return Response.json(
          { error: "a turn is running in this project" },
          { status: deleteStatus },
        );
      projects = projects.filter((project) => path !== `/projects/${project.projectId}`);
      return Response.json({ deleted: true });
    }
    return Response.json({ configured: false });
  });
  return { deleted };
}

async function remove(name: string) {
  fireEvent.click(await screen.findByRole("button", { name: `Session actions for ${name}` }));
  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  fireEvent.click(screen.getByRole("button", { name: "Delete session" }));
}

describe("deleting workspace sessions", () => {
  it("leaves the deleted active project for the dashboard after a successful response", async () => {
    const api = server(200);
    render(<SessionSidebar projectId={PROJECT_ID} />);
    await remove("Current app");
    await waitFor(() => expect(api.deleted).toEqual([`/projects/${PROJECT_ID}`]));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/dashboard"));
    expect(navigate).toHaveBeenCalledOnce();
  });

  it("keeps the active workspace when deletion is refused and shows why", async () => {
    server(409);
    render(<SessionSidebar projectId={PROJECT_ID} />);
    await remove("Current app");
    expect(await screen.findByRole("alert")).toHaveTextContent("a turn is running in this project");
    expect(navigate).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Session actions for Current app" }),
    ).toBeInTheDocument();
  });

  it("keeps the active workspace when a different project is deleted", async () => {
    const api = server(200);
    render(<SessionSidebar projectId={PROJECT_ID} />);
    await remove("Other app");
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Session actions for Other app" })).toBeNull(),
    );
    expect(api.deleted).toEqual([`/projects/${OTHER_PROJECT}`]);
    expect(navigate).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Session actions for Current app" }),
    ).toBeInTheDocument();
  });
});
