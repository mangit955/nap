import { z } from "zod";
import { DiffStatSchema } from "./git-protocol.ts";
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
  /**
   * The newest request's admission or claim, whichever is later. What a settle is compared with
   * (`sessionSection`) and what the inbox sorts by; it is not a run's start, because a queued
   * request has one and has not started.
   */
  requestedAt: z.iso.datetime().nullable(),
  /**
   * When the request running now was claimed and began — the card's *Working 1:42* counts from
   * here. Null unless something is running: a queued turn is drawn as queued, with no timer.
   *
   * The four card fields below each default to null, so a browser newer than the API it talks to
   * draws a card without them rather than failing to parse the whole list.
   */
  runStartedAt: z.iso.datetime().nullable().default(null),
  /**
   * When the newest turn or job ended, however it ended. *Done* (an unread completion) is this
   * against the read watermark; `activityAt` would not do, because pull request feedback moves it
   * without anything having finished.
   */
  turnFinishedAt: z.iso.datetime().nullable().default(null),
  /** Lines the newest turn that committed added and removed, counted when it committed. */
  diff: DiffStatSchema.nullable().default(null),
  /** The model the newest turn ran on, as the request named it. */
  model: z.string().nullable().default(null),
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

/**
 * The bounds of a sidebar search. Two characters is the shortest query a trigram index can answer
 * without reading every message; a hundred is longer than anything typed into a search box; twenty
 * results is more than the listbox shows without scrolling.
 */
export const SESSION_SEARCH_MIN = 2;
export const SESSION_SEARCH_MAX = 100;
export const SESSION_SEARCH_LIMIT = 20;
export const SessionSearchQuerySchema = z
  .string()
  .trim()
  .min(SESSION_SEARCH_MIN)
  .max(SESSION_SEARCH_MAX);

/**
 * One session a search found: by its name, or by one of the person's own messages, with the part
 * of the message around the match. `cutStart` and `cutEnd` say whether the snippet was taken from
 * the middle of a longer message, so the listbox can draw an ellipsis without guessing.
 */
export const SessionSearchResultSchema = z.object({
  projectId: z.uuid(),
  name: z.string(),
  match: z.discriminatedUnion("in", [
    z.object({ in: z.literal("name") }),
    z.object({
      in: z.literal("message"),
      snippet: z.string(),
      cutStart: z.boolean(),
      cutEnd: z.boolean(),
      at: z.iso.datetime(),
    }),
  ]),
});
export type SessionSearchResult = z.infer<typeof SessionSearchResultSchema>;
export const SessionSearchSchema = z.object({ results: z.array(SessionSearchResultSchema) });
export type SessionSearch = z.infer<typeof SessionSearchSchema>;

/**
 * When the reaper settles a session on its owner's behalf. Both rules are off until the owner
 * turns them on, and neither ever touches a pinned or busy session.
 *
 * `afterDays` settles a session nothing has happened in for that many days; `onMerge` settles one
 * whose pull request merged after its last turn.
 */
export const AUTO_SETTLE_MAX_DAYS = 365;
export const AutoSettleSettingsSchema = z.object({
  afterDays: z.int().min(1).max(AUTO_SETTLE_MAX_DAYS).nullable(),
  onMerge: z.boolean(),
});
export type AutoSettleSettings = z.infer<typeof AutoSettleSettingsSchema>;
export const AUTO_SETTLE_OFF: AutoSettleSettings = { afterDays: null, onMerge: false };

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
