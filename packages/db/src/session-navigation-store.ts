import type {
  NavigationResult,
  SessionNavigationStore,
} from "@nap/shared/ports/session-navigation-store";
import {
  type NavigationChange,
  NavigationSchema,
  type SessionList,
  type SessionReorder,
  SessionSummarySchema,
  sessionSection,
} from "@nap/shared/session-navigation";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { z } from "zod";
import { projects, sessions, turnRequests } from "./schema.ts";

const timestamp = z.coerce.date().transform((value) => value.toISOString());
const SummaryRow = SessionSummarySchema.extend({
  createdAt: timestamp,
  updatedAt: timestamp,
  activityAt: timestamp.nullable(),
  requestedAt: timestamp.nullable(),
});
const PAGE_SIZE = 100;

export class PostgresSessionNavigationStore implements SessionNavigationStore {
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
      const navigation = NavigationSchema.parse(project.navigation);
      const now = new Date().toISOString();
      switch (change.kind) {
        case "pin":
          navigation.pinned = change.pinned;
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
      const revision = project.navigationRevision + 1;
      await tx
        .update(projects)
        .set({ navigation, navigationRevision: revision })
        .where(eq(projects.id, projectId));
      return { kind: "saved", navigation, revision };
    });
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
}
