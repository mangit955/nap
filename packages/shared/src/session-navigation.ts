import { z } from "zod";
import { ProjectSummarySchema } from "./projects-protocol.ts";

export const NavigationSchema = z.object({
  pinned: z.boolean().default(false),
  position: z.number().int().nonnegative().nullable().default(null),
  doneAt: z.iso.datetime().nullable().default(null),
  archivedAt: z.iso.datetime().nullable().default(null),
  snoozedUntil: z.iso.datetime().nullable().default(null),
  readAt: z.iso.datetime().nullable().default(null),
  unread: z.boolean().default(false),
});
export type SessionNavigation = z.infer<typeof NavigationSchema>;
export const SessionSectionSchema = z.enum(["pinned", "active", "snoozed", "done", "archived"]);
export type SessionSection = z.infer<typeof SessionSectionSchema>;
export const SessionSummarySchema = ProjectSummarySchema.extend({
  createdAt: z.iso.datetime(),
  navigation: NavigationSchema,
  revision: z.number().int().nonnegative(),
  activity: z.enum(["ready", "queued", "working", "completed", "attention"]),
  activityAt: z.iso.datetime().nullable(),
  requestedAt: z.iso.datetime().nullable(),
  repository: z.string().nullable(),
  branch: z.string().nullable(),
  pullRequest: z
    .object({
      number: z.number().int(),
      url: z.url(),
      state: z.enum(["open", "closed", "merged"]),
    })
    .nullable(),
  pendingFeedback: z.number().int().nonnegative(),
});
export type SessionSummary = z.infer<typeof SessionSummarySchema>;
export const SessionListSchema = z.object({
  sessions: z.array(SessionSummarySchema),
  next: z.uuid().nullable(),
});
export type SessionList = z.infer<typeof SessionListSchema>;

export const NavigationChangeSchema = z.object({
  revision: z.number().int().nonnegative(),
  change: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("pin"), pinned: z.boolean() }),
    z.object({ kind: z.literal("done"), value: z.boolean() }),
    z.object({ kind: z.literal("archive"), value: z.boolean() }),
    z.object({ kind: z.literal("snooze"), until: z.iso.datetime().nullable() }),
    z.object({ kind: z.literal("read"), at: z.iso.datetime().nullable(), unread: z.boolean() }),
    z.object({ kind: z.literal("restore"), navigation: NavigationSchema }),
  ]),
});
export type NavigationChange = z.infer<typeof NavigationChangeSchema>;
/**
 * What one change does to a session's navigation — the store persists exactly this, and the web
 * client applies the same function to draw the result before the server has answered. Two copies
 * would drift, and the drift would show as a row that lands on one shelf and then jumps to
 * another when the reply arrives. `now` stamps settling and archiving.
 */
export function applyNavigationChange(
  current: SessionNavigation,
  change: NavigationChange["change"],
  now: string,
): SessionNavigation {
  const navigation = { ...current };
  switch (change.kind) {
    case "pin":
      navigation.pinned = change.pinned;
      // A position is a place in one list; a row that changes list has no place in the new one.
      navigation.position = null;
      break;
    case "done":
      navigation.doneAt = change.value ? now : null;
      navigation.snoozedUntil = null;
      break;
    case "archive":
      navigation.archivedAt = change.value ? now : null;
      break;
    case "snooze":
      navigation.snoozedUntil = change.until;
      navigation.doneAt = null;
      break;
    case "read":
      navigation.unread = change.unread;
      // A delayed read must not acknowledge activity the caller never observed.
      if (!change.unread && change.at && (!navigation.readAt || change.at > navigation.readAt))
        navigation.readAt = change.at;
      break;
    case "restore":
      Object.assign(navigation, change.navigation);
      break;
  }
  return navigation;
}

export const NavigationSavedSchema = z.object({
  navigation: NavigationSchema,
  revision: z.number().int().nonnegative(),
});
export const SessionReorderSchema = z
  .object({
    section: SessionSectionSchema,
    rows: z
      .array(z.object({ projectId: z.uuid(), revision: z.number().int().nonnegative() }))
      .min(1)
      .max(10000),
  })
  .refine(
    (value) => new Set(value.rows.map((row) => row.projectId)).size === value.rows.length,
    "Each session may appear only once.",
  );
export type SessionReorder = z.infer<typeof SessionReorderSchema>;

export function sessionSection(session: SessionSummary, now: number): SessionSection {
  const nav = session.navigation;
  const active = session.activity === "queued" || session.activity === "working";
  const requested = session.requestedAt === null ? 0 : Date.parse(session.requestedAt);
  if (!active) {
    if (nav.archivedAt && requested <= Date.parse(nav.archivedAt)) return "archived";
    if (nav.doneAt && requested <= Date.parse(nav.doneAt)) return "done";
    if (nav.snoozedUntil && Date.parse(nav.snoozedUntil) > now) return "snoozed";
  }
  return nav.pinned ? "pinned" : "active";
}
