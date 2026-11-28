/**
 * The dashboard's arithmetic, kept away from its markup.
 *
 * Which projects the grid shows, which ones the sidebar lists, what to call the person looking
 * at the page. None of it needs React, so none of it is in a component — a filter that can be
 * checked without mounting anything is a filter that stays checked.
 */

import type { ProjectSummaryPayload } from "@nap/shared/projects-protocol";

/**
 * The three lists the sidebar offers.
 *
 * The split is on whether a sandbox is *serving* the project, not on the `status` column:
 * `projectState` calls a project with no sandbox either "put away" or "new" depending on how it
 * got that way, and both answer the same question the same way — there is nothing running to
 * open. Splitting on the column instead would leave a project in neither half, and a count in
 * the sidebar that does not add up is a count nobody trusts again.
 */
type ProjectScope = "all" | "running" | "put-away";

export type GridFilter = { query: string; scope: ProjectScope };

export function filterProjects(
  projects: readonly ProjectSummaryPayload[],
  { query, scope }: GridFilter,
): ProjectSummaryPayload[] {
  const needle = query.trim().toLowerCase();

  return projects.filter((project) => {
    // Within the scope rather than across it: a search that reached outside would quietly undo
    // the selection the sidebar is still showing as active.
    if (scope === "running" && project.sandboxId === null) return false;
    if (scope === "put-away" && project.sandboxId !== null) return false;
    return needle === "" || project.name.toLowerCase().includes(needle);
  });
}

/** What the sidebar puts beside each scope. Unfiltered by the search, since it is a total. */
export function scopeCounts(
  projects: readonly ProjectSummaryPayload[],
): Record<ProjectScope, number> {
  const running = projects.filter((project) => project.sandboxId !== null).length;
  return { all: projects.length, running, "put-away": projects.length - running };
}

/**
 * The handful of projects worth putting in the sidebar, newest first.
 *
 * Sorted here rather than trusted from the server: the list endpoint's order is its own
 * business, and a "Recents" that is only recent by coincidence is worse than none. Copied
 * before sorting, because sorting the caller's array in place would reorder the grid as a side
 * effect of drawing the sidebar.
 */
export function recentProjects(
  projects: readonly ProjectSummaryPayload[],
  limit = 5,
): ProjectSummaryPayload[] {
  return [...projects]
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
    .slice(0, limit);
}

/**
 * The name in the greeting.
 *
 * First word only — "Let's build something, Manas Raghuwanshi" reads as a form letter. The
 * email's local part is the fallback because signing up does not require a name, and "there"
 * is the last resort: the greeting is the first line on the page and cannot render a gap.
 */
export function greetingName(
  user: { name?: string | null; email?: string | null } | undefined,
): string {
  const first = user?.name?.trim().split(/\s+/)[0];
  if (first !== undefined && first !== "") return first;

  const local = user?.email?.split("@")[0]?.trim();
  if (local !== undefined && local !== "") return local;

  return "there";
}
