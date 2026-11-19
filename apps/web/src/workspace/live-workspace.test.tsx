import { render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { LiveWorkspace } from "./live-workspace.tsx";

vi.mock("next/navigation", () => ({
  usePathname: () => "/p/project",
  useRouter: () => ({ replace: vi.fn() }),
}));
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
it("scopes workspace drafts to the authenticated owner", () => {
  render(<LiveWorkspace />);
  expect(screen.getByText("owner/project")).toBeVisible();
});
