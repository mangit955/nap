import type { SessionSummary } from "@nap/shared/session-navigation";
import { MessageSquare } from "lucide-react";
import type { Command } from "../palette/commands.ts";
import { compactTime, rowStatus, shelveSessions } from "./session-rows.ts";

/**
 * The palette's Sessions group: every session the sidebar shelves, in the sidebar's own order
 * whatever its shelves or filter currently show, so a session is found by name even when its
 * shelf is collapsed. Archived ones are left out, as the sidebar leaves them out.
 */
export function sessionCommands(
  sessions: readonly SessionSummary[],
  now: number,
  open: (projectId: string) => void,
): Command[] {
  const shelves = shelveSessions(sessions, now);
  return [...shelves.pinned, ...shelves.active, ...shelves.snoozed, ...shelves.settled].map(
    (session, index) => {
      const status = rowStatus(session, now);
      const working = status?.kind === "working" || status?.kind === "queued";
      return {
        id: `session:${session.projectId}`,
        group: "Sessions",
        order: index,
        label: session.name,
        icon: <MessageSquare className="size-4" aria-hidden />,
        meta: working ? (
          <span className="text-info">{status.kind === "queued" ? "Queued" : "Working"}</span>
        ) : (
          compactTime(session.requestedAt ?? session.updatedAt, now)
        ),
        run: () => open(session.projectId),
      };
    },
  );
}
