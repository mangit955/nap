import type { ReactNode } from "react";
import { WorkspaceFrame } from "../../workspace/workspace-frame.tsx";

/**
 * The frame and sidebar every project's page shares. A layout, not part of the page, so that
 * switching from one project to another keeps it mounted — see `WorkspaceFrame`.
 */
export default function Layout({ children }: { children: ReactNode }) {
  return <WorkspaceFrame>{children}</WorkspaceFrame>;
}
