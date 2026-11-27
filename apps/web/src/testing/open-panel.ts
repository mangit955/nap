import { DEFAULT_PANEL_LAYOUT } from "../workspace/tabs.ts";

/**
 * Leaves the right panel open for a project's workspace, as somebody who opened it once would
 * find it: the panel starts closed where nothing is saved, and these tests look inside it. Saved
 * for the project before its session is known, which the session's layout then starts from.
 */
export function savePanelOpen(projectId: string, ownerId = "guest"): void {
  localStorage.setItem(
    `nap.right-panel.v1:${ownerId}:${projectId}:pending`,
    JSON.stringify({ ...DEFAULT_PANEL_LAYOUT, open: true }),
  );
}
