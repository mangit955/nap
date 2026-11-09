/**
 * The sidebar's rows as they will be once the server has answered.
 *
 * The list the server last sent is one fact, and the actions somebody has taken since are
 * another; drawing the second over the first is what makes a pin or a settle land at once.
 * Keeping them apart, rather than editing the list in place, is what makes a refusal cheap to
 * show: the refused action leaves the queue, the fold runs again, and every row is where the
 * server says it is — with whatever else is still on its way drawn on top. A poll arriving
 * mid-flight is just a new first fact under the same queue, so it cannot flicker a row back.
 */

import {
  applyNavigationChange,
  type NavigationChange,
  type SessionSection,
  type SessionSummary,
} from "@nap/shared/session-navigation";

export type PendingOp =
  | { kind: "change"; projectId: string; change: NavigationChange["change"]; at: string }
  | { kind: "reorder"; section: SessionSection; projectIds: readonly string[] }
  | { kind: "rename"; projectId: string; name: string }
  | { kind: "remove"; projectId: string }
  | { kind: "close"; projectId: string };

/** One pending action drawn over `rows`. A row no longer in the list is left alone. */
export function applyPending(rows: readonly SessionSummary[], op: PendingOp): SessionSummary[] {
  if (op.kind === "remove") return rows.filter((row) => row.projectId !== op.projectId);
  if (op.kind === "reorder") {
    const positions = new Map(op.projectIds.map((id, index) => [id, index]));
    return rows.map((row) => {
      const position = positions.get(row.projectId);
      return position === undefined ? row : { ...row, navigation: { ...row.navigation, position } };
    });
  }
  return rows.map((row) => {
    if (row.projectId !== op.projectId) return row;
    if (op.kind === "rename") return { ...row, name: op.name };
    if (op.kind === "close") return { ...row, sandboxId: null };
    return {
      ...row,
      navigation: applyNavigationChange(
        row.navigation,
        op.change,
        notBefore(op.at, row.requestedAt),
      ),
    };
  });
}

/** The confirmed rows with every pending action drawn over them, oldest first. */
export function withPending(
  confirmed: readonly SessionSummary[],
  pending: readonly PendingOp[],
): SessionSummary[] {
  return pending.reduce<SessionSummary[]>((rows, op) => applyPending(rows, op), [...confirmed]);
}

/**
 * The server stamps a settle with its own clock and only counts it if it is not before the
 * newest request. This clock may be behind that one, so the drawn stamp never precedes it.
 */
function notBefore(at: string, requestedAt: string | null): string {
  return requestedAt !== null && Date.parse(requestedAt) >= Date.parse(at)
    ? new Date(Date.parse(requestedAt) + 1).toISOString()
    : at;
}
