import { render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { LiveWorkspace } from "./live-workspace.tsx";

vi.mock("../auth/client.ts", () => ({
  authClient: { useSession: () => ({ data: { user: { id: "owner" } }, isPending: false }) },
}));
vi.mock("../components/app-shell.tsx", () => ({
  AppShell: ({ ownerId, projectId }: { ownerId: string; projectId: string }) => (
    <p>
      {ownerId}/{projectId}
    </p>
  ),
}));
vi.mock("./session-sidebar.tsx", () => ({ SessionSidebar: () => <p>Sessions</p> }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn() }) }));
it("scopes workspace drafts to the authenticated owner", () => {
  render(<LiveWorkspace projectId="project" />);
  expect(screen.getByText("owner/project")).toBeVisible();
});
