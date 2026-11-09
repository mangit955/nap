import type {
  NavigationResult,
  SessionAutoSettler,
  SessionNavigationStore,
} from "@nap/shared/ports/session-navigation-store";
import {
  AUTO_SETTLE_OFF,
  type AutoSettleSettings,
  applyNavigationChange,
  type NavigationChange,
  NavigationSchema,
  SESSION_SEARCH_LIMIT,
  type SessionList,
  type SessionReorder,
  type SessionSearch,
  SessionSummarySchema,
  sessionSection,
} from "@nap/shared/session-navigation";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { z } from "zod";
import { TITLE_CLAIM_EXPIRY } from "./postgres-project-title-store.ts";
import { navigationSettings, projects, sessions, turnRequests } from "./schema.ts";

const timestamp = z.coerce.date().transform((value) => value.toISOString());
const SummaryRow = SessionSummarySchema.extend({
  createdAt: timestamp,
  updatedAt: timestamp,
  activityAt: timestamp.nullable(),
  requestedAt: timestamp.nullable(),
  runStartedAt: timestamp.nullable(),
  turnFinishedAt: timestamp.nullable(),
});
const PAGE_SIZE = 100;
/** How many sessions one reaper tick may settle; the next tick takes the rest. */
const AUTO_SETTLE_BATCH = 200;
/** Characters of a matching message shown before the match, and in all. */
const SNIPPET_LEAD = 60;
const SNIPPET_LENGTH = 200;

const SearchRow = z.object({
  project_id: z.uuid(),
  name: z.string(),
  kind: z.enum(["name", "message"]),
  snippet: z.string().nullable(),
  cut_start: z.boolean().nullable(),
  cut_end: z.boolean().nullable(),
  at: timestamp,
});

/**
 * `query` as an `ilike` pattern matching it anywhere, with its own `%`, `_` and backslash taken
 * literally. Unescaped, a search for `50%` would match every message containing `50`.
 */
export function containsPattern(query: string): string {
  return `%${query.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}

/**
 * Now, written the way `applyNavigationChange` writes its stamps (`toISOString`, milliseconds,
 * UTC), from the database's clock — the clock every reaper and every API pod agrees on.
 */
const NOW_ISO = sql`to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

export class PostgresSessionNavigationStore implements SessionNavigationStore, SessionAutoSettler {
  constructor(private readonly db: PostgresJsDatabase) {}

  async list(userId: string, after?: string): Promise<SessionList> {
    const rows = await this.db.execute(sql`
      select jsonb_build_object(
        'projectId', p.id, 'name', p.name, 'status', p.status, 'sandboxId', p.sandbox_id,
        'createdAt', p.created_at, 'updatedAt', p.updated_at,
        'sessionIds', coalesce(s.ids, '[]'::jsonb),
        'navigation', p.navigation, 'revision', p.navigation_revision,
        'activity', case when r.state = 'leased' then 'working' when r.state = 'queued' then 'queued'
          when r.state in ('failed','orphaned') or coalesce(f.pending,0) > 0 then 'attention'
          when e.type = 'turn.failed' or (e.type = 'job.completed' and e.payload->>'outcome' in ('exhausted','abandoned')) then 'attention'
          when e.type in ('turn.completed','job.completed') then 'completed' else 'ready' end,
        'activityAt', greatest(r.created_at, r.started_at, r.finished_at, e.created_at, f.latest),
        'requestedAt', greatest(r.created_at, r.started_at),
        'runStartedAt', case when r.state = 'leased' then r.started_at end,
        'turnFinishedAt', t.created_at,
        'diff', d.diff,
        'model', m.model,
        'titling', p.title_generation is not null
          and p.title_requested_at > now() - ${TITLE_CLAIM_EXPIRY}::interval,
        'repository', pr.repository->>'fullName',
        'branch', j.head_branch,
        'pullRequest', case when j.pull_request_number is null then null else jsonb_build_object(
          'number', j.pull_request_number, 'url', j.pull_request_url, 'state', j.pull_request_state) end,
        'pendingFeedback', coalesce(f.pending,0)
      ) as item
      from (select * from projects where user_id = ${userId} ${after ? sql`and id > ${after}` : sql``} order by id limit ${PAGE_SIZE + 1}) p
      left join lateral (select jsonb_agg(id order by created_at desc, id desc) as ids from sessions where project_id = p.id) s on true
      left join lateral (
        select tr.* from turn_requests tr join sessions ss on ss.id = tr.session_id where ss.project_id = p.id
        order by case tr.state when 'leased' then 0 when 'queued' then 1 else 2 end, tr.created_at desc, tr.id desc limit 1
      ) r on true
      left join lateral (
        select ev.type, ev.payload, ev.created_at from events ev join sessions ss on ss.id = ev.session_id
        where ss.project_id = p.id and ev.type in ('turn.completed','turn.failed','job.completed')
          and (r.id is null or ev.created_at >= r.created_at)
        order by ev.created_at desc, ev.seq desc limit 1
      ) e on true
      left join lateral (
        select ev.created_at from events ev join sessions ss on ss.id = ev.session_id
        where ss.project_id = p.id and ev.type in ('turn.completed','turn.failed','job.completed')
        order by ev.created_at desc, ev.seq desc limit 1
      ) t on true
      left join lateral (
        select ev.payload->'diff' as diff from events ev join sessions ss on ss.id = ev.session_id
        where ss.project_id = p.id and ev.type = 'turn.completed' and ev.payload->>'commitSha' is not null
        order by ev.created_at desc, ev.seq desc limit 1
      ) d on true
      left join lateral (
        select tr.model from turn_requests tr join sessions ss on ss.id = tr.session_id
        where ss.project_id = p.id and tr.kind in ('turn','test') and tr.started_at is not null
        order by tr.started_at desc, tr.id desc limit 1
      ) m on true
      left join project_repositories pr on pr.project_id = p.id
      left join lateral (select * from repository_jobs where project_id = p.id order by created_at desc, job_id desc limit 1) j on true
      left join lateral (select count(*)::int as pending, max(created_at) as latest from repository_feedback where project_id = p.id and request_id is null) f on true
      order by p.id
    `);
    const parsed = rows.map((row) => SummaryRow.parse(row.item));
    const page = parsed.slice(0, PAGE_SIZE);
    return {
      sessions: page,
      next: parsed.length > PAGE_SIZE ? (page.at(-1)?.projectId ?? null) : null,
    };
  }

  async change(
    userId: string,
    projectId: string,
    input: NavigationChange,
  ): Promise<NavigationResult> {
    return this.db.transaction(async (tx): Promise<NavigationResult> => {
      const [project] = await tx
        .select()
        .from(projects)
        .where(and(eq(projects.id, projectId), eq(projects.userId, userId)))
        .for("update");
      if (!project) return { kind: "missing" };
      if (project.navigationRevision !== input.revision) return { kind: "conflict" };
      const change = input.change;
      const parks =
        change.kind === "done" || change.kind === "archive"
          ? change.value
          : change.kind === "snooze"
            ? change.until !== null
            : change.kind === "restore" &&
              !!(
                change.navigation.doneAt ||
                change.navigation.archivedAt ||
                change.navigation.snoozedUntil
              );
      if (parks) {
        const pending = await tx
          .select({ id: turnRequests.id })
          .from(turnRequests)
          .innerJoin(sessions, eq(sessions.id, turnRequests.sessionId))
          .where(
            and(
              eq(sessions.projectId, projectId),
              inArray(turnRequests.state, ["queued", "leased"]),
            ),
          )
          .limit(1);
        if (pending.length) return { kind: "busy" };
      }
      const navigation = applyNavigationChange(
        NavigationSchema.parse(project.navigation),
        change,
        new Date().toISOString(),
      );
      const revision = project.navigationRevision + 1;
      // Taking a session out of Settled, however it is done — Un-settle, a snooze, a drag, an Undo
      // — is the owner overruling the auto-settle rules for everything that has happened so far.
      // Settled as the sidebar draws it (`sessionSection`): a stamp older than the newest request
      // was already overruled by that request, and clearing it overrules nothing.
      const before = project.navigation.doneAt;
      const unsettled =
        before !== null &&
        navigation.doneAt === null &&
        Date.parse(before) >= (await this.#lastRequested(tx, projectId));
      await tx
        .update(projects)
        .set({
          navigation,
          navigationRevision: revision,
          ...(unsettled ? { autoSettleFloor: sql`now()` } : {}),
        })
        .where(eq(projects.id, projectId));
      return { kind: "saved", navigation, revision };
    });
  }

  /** When the project's newest request was admitted or claimed, as epoch ms; 0 for none. */
  async #lastRequested(tx: Pick<PostgresJsDatabase, "select">, projectId: string): Promise<number> {
    const [newest] = await tx
      .select({
        at: sql<number>`extract(epoch from greatest(${turnRequests.createdAt}, ${turnRequests.startedAt})) * 1000`.mapWith(
          Number,
        ),
      })
      .from(turnRequests)
      .innerJoin(sessions, eq(sessions.id, turnRequests.sessionId))
      .where(eq(sessions.projectId, projectId))
      .orderBy(desc(turnRequests.createdAt), desc(turnRequests.id))
      .limit(1);
    return newest?.at ?? 0;
  }

  async reorder(
    userId: string,
    input: SessionReorder,
  ): Promise<{ kind: "saved" | "missing" | "conflict" }> {
    return this.db.transaction(async (tx) => {
      const ids = input.rows.map((row) => row.projectId);
      const locked = await tx
        .select()
        .from(projects)
        .where(and(eq(projects.userId, userId), inArray(projects.id, ids)))
        .orderBy(asc(projects.id))
        .for("update");
      if (locked.length !== ids.length) return { kind: "missing" };
      const activityRows = await tx.execute(sql`
        select distinct on (ss.project_id) ss.project_id, tr.state,
          greatest(tr.created_at, tr.started_at) as requested_at
        from turn_requests tr join sessions ss on ss.id = tr.session_id
        where ss.project_id in (${sql.join(
          ids.map((id) => sql`${id}::uuid`),
          sql`,`,
        )})
        order by ss.project_id, case tr.state when 'leased' then 0 when 'queued' then 1 else 2 end,
          tr.created_at desc, tr.id desc
      `);
      const activity = new Map(
        activityRows.map((raw) => {
          const item = z
            .object({ project_id: z.uuid(), state: z.string(), requested_at: timestamp })
            .parse(raw);
          return [item.project_id, item];
        }),
      );
      for (const row of locked) {
        const expected = input.rows.find((item) => item.projectId === row.id);
        if (expected?.revision !== row.navigationRevision) return { kind: "conflict" };
        const request = activity.get(row.id);
        const group = sessionSection(
          {
            projectId: row.id,
            name: row.name,
            status: row.status,
            sandboxId: row.sandboxId,
            sessionIds: [],
            updatedAt: row.updatedAt.toISOString(),
            createdAt: row.createdAt.toISOString(),
            navigation: NavigationSchema.parse(row.navigation),
            revision: row.navigationRevision,
            activity:
              request?.state === "leased"
                ? "working"
                : request?.state === "queued"
                  ? "queued"
                  : "ready",
            activityAt: null,
            requestedAt: request?.requested_at ?? null,
            runStartedAt: null,
            turnFinishedAt: null,
            diff: null,
            model: null,
            titling: false,
            repository: null,
            branch: null,
            pullRequest: null,
            pendingFeedback: 0,
          },
          Date.now(),
        );
        if (group !== input.section) return { kind: "conflict" };
      }
      for (const [position, requested] of input.rows.entries()) {
        await tx
          .update(projects)
          .set({
            navigation: sql`jsonb_set(${projects.navigation}, '{position}', ${JSON.stringify(position)}::jsonb)`,
            navigationRevision: requested.revision + 1,
          })
          .where(eq(projects.id, requested.projectId));
      }
      return { kind: "saved" };
    });
  }

  async search(userId: string, query: string): Promise<SessionSearch> {
    const pattern = containsPattern(query);
    // Scoped to the caller in the statement itself, like every other read here. Message matches
    // come from the trigram index (`events_message_text_trgm`), whose predicate the `type in`
    // below repeats exactly so the planner can use it. A repair prompt is the verifier's words,
    // not the person's, so it is not searched.
    const rows = await this.db.execute(sql`
      with hits as (
        select p.id as project_id, p.name, 'name' as kind, null::text as text, p.created_at as at
        from projects p where p.user_id = ${userId} and p.name ilike ${pattern}
        union all
        (select distinct on (p.id) p.id, p.name, 'message', ev.payload->>'text', ev.created_at
        from events ev
        join sessions ss on ss.id = ev.session_id
        join projects p on p.id = ss.project_id
        where p.user_id = ${userId}
          and ev.type in ('user.message', 'steer.received')
          and not (ev.payload ? 'repair')
          and (ev.payload->>'text') ilike ${pattern}
        order by p.id, ev.created_at desc, ev.seq desc)
      ),
      best as (
        select distinct on (project_id) * from hits order by project_id, (kind = 'name') desc, at desc
      )
      select project_id, name, kind, at,
        case when kind = 'message' then substr(text, w.start, ${SNIPPET_LENGTH}) end as snippet,
        case when kind = 'message' then w.start > 1 end as cut_start,
        case when kind = 'message' then w.start + ${SNIPPET_LENGTH} <= length(text) end as cut_end
      from best
      cross join lateral (
        select greatest(1, strpos(lower(coalesce(text, '')), lower(${query})) - ${SNIPPET_LEAD}) as start
      ) w
      order by (kind = 'name') desc, at desc, project_id
      limit ${SESSION_SEARCH_LIMIT}
    `);
    return {
      results: rows.map((raw) => {
        const row = SearchRow.parse(raw);
        return {
          projectId: row.project_id,
          name: row.name,
          match:
            row.kind === "name"
              ? { in: "name" as const }
              : {
                  in: "message" as const,
                  snippet: row.snippet ?? "",
                  cutStart: row.cut_start ?? false,
                  cutEnd: row.cut_end ?? false,
                  at: row.at,
                },
        };
      }),
    };
  }

  async autoSettleSettings(userId: string): Promise<AutoSettleSettings> {
    const [row] = await this.db
      .select()
      .from(navigationSettings)
      .where(eq(navigationSettings.userId, userId));
    if (!row) return AUTO_SETTLE_OFF;
    return { afterDays: row.autoSettleAfterDays, onMerge: row.autoSettleOnMerge };
  }

  async saveAutoSettleSettings(userId: string, settings: AutoSettleSettings): Promise<void> {
    const values = {
      autoSettleAfterDays: settings.afterDays,
      autoSettleOnMerge: settings.onMerge,
      updatedAt: new Date(),
    };
    await this.db
      .insert(navigationSettings)
      .values({ userId, ...values })
      .onConflictDoUpdate({ target: navigationSettings.userId, set: values });
  }

  /**
   * Settles, as the owner would, every session their rules say has gone quiet or shipped. One
   * statement, so there is no gap between deciding and writing for a turn to start in; the rules
   * are all in its `where`, so running it again settles nothing it already settled.
   *
   * - Only owners with a `navigation_settings` row, and only the rules they turned on.
   * - Never pinned, snoozed, or busy, and never archived or already settled as the sidebar draws
   *   it (`sessionSection`): a stamp older than the newest request no longer counts. Busy is a request queued or
   *   leased in any of the project's sessions — the rule a manual settle answers `busy` with, so
   *   the reaper cannot settle what its owner could not. A turn admitted just after this commits
   *   reopens the session anyway, as it would after a manual settle.
   * - Never on activity at or before `auto_settle_floor`, which this stamps and which an owner
   *   un-settling stamps, so neither the rule nor the owner is overruled by the same history.
   * - A snooze that has ended counts as activity, for both rules: the session comes back saying
   *   *Woke*, and filing it away on the next tick would mean nobody ever saw that.
   * - The merge rule needs the GitHub integration's own record of when the pull request merged
   *   (`pull_request_merged_at`, written once), and counts it only if it came after the session's
   *   last request: a merged pull request followed by more work is not a reason to settle that
   *   work.
   */
  async autoSettle(limit = AUTO_SETTLE_BATCH): Promise<string[]> {
    const rows = await this.db.execute(sql`
      with due as (
        select p.id
        from projects p
        join navigation_settings ns on ns.user_id = p.user_id
        left join lateral (
          select greatest(tr.created_at, tr.started_at) as requested,
            greatest(tr.created_at, tr.started_at, tr.finished_at) as touched
          from turn_requests tr join sessions ss on ss.id = tr.session_id
          where ss.project_id = p.id
          order by tr.created_at desc, tr.id desc limit 1
        ) w on true
        left join lateral (
          select max(created_at) as at from repository_feedback where project_id = p.id
        ) fb on true
        left join lateral (
          select pull_request_state, pull_request_merged_at as merged_at from repository_jobs
          where project_id = p.id order by created_at desc, job_id desc limit 1
        ) j on true
        cross join lateral (
          select greatest(w.touched, (p.navigation->>'snoozedUntil')::timestamptz) as active_at,
            coalesce(w.requested, '-infinity'::timestamptz) as requested,
            coalesce(p.auto_settle_floor, '-infinity'::timestamptz) as floor
        ) a
        cross join lateral (
          select greatest(p.created_at, a.active_at, fb.at) as quiet_since, a.floor
        ) q
        where (ns.auto_settle_after_days is not null or ns.auto_settle_on_merge)
          and coalesce((p.navigation->>'pinned')::boolean, false) = false
          and coalesce((p.navigation->>'archivedAt')::timestamptz < a.requested, true)
          and coalesce((p.navigation->>'snoozedUntil')::timestamptz <= now(), true)
          and coalesce((p.navigation->>'doneAt')::timestamptz < a.requested, true)
          and not exists (
            select 1 from turn_requests busy join sessions ss on ss.id = busy.session_id
            where ss.project_id = p.id and busy.state in ('queued', 'leased')
          )
          and (
            (ns.auto_settle_after_days is not null
              and q.quiet_since < now() - make_interval(days => ns.auto_settle_after_days)
              and q.quiet_since > q.floor)
            or (ns.auto_settle_on_merge
              and j.pull_request_state = 'merged'
              and j.merged_at > coalesce(a.active_at, '-infinity'::timestamptz)
              and j.merged_at > q.floor)
          )
        order by p.id
        limit ${limit}
        for update of p skip locked
      )
      update projects p set
        navigation = jsonb_set(
          jsonb_set(p.navigation, '{doneAt}', to_jsonb(${NOW_ISO})), '{snoozedUntil}', 'null'::jsonb),
        navigation_revision = p.navigation_revision + 1,
        auto_settle_floor = now()
      from due where p.id = due.id
      returning p.id
    `);
    return rows.map((row) => z.object({ id: z.uuid() }).parse(row).id);
  }
}
