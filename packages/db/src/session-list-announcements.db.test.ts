/**
 * Every Postgres write that changes what a session card draws announces its owner, after it
 * commits — and the writes that change nothing visible stay quiet.
 *
 * A tab no longer reads its session list every ten seconds: it waits to be told, with a slow read
 * behind it for notices that get lost. So a writer that forgets to announce breaks nothing its own
 * tests notice; the change shows up minutes late, every time. This file is what notices.
 * `test/session-list-writers.test.ts` is its tripwire for a writer that does not exist yet.
 *
 * **After the commit**, for every writer: the database each store is handed counts the
 * transactions open on it, and an announcement made while one is open fails the test after it
 * (`afterEach`). A notice sent before the commit would be answered with the old row, and the tab
 * would then sit on it until the next notice. The writes a tab most often waits on are also read
 * from another connection at the moment of the call, as the tab's `GET /sessions` would read them.
 */

import { randomUUID } from "node:crypto";
import type { ImportRepository } from "@nap/shared/ports/github-store";
import type { SessionListOwner } from "@nap/shared/ports/session-list-channel";
import { eq, inArray } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from "vitest";
import { PostgresGitHubStore } from "./github-store.ts";
import { PostgresProjectSandboxStore } from "./postgres-project-sandbox-store.ts";
import { PostgresProjectStore } from "./postgres-project-store.ts";
import { PostgresProjectTitleStore } from "./postgres-project-title-store.ts";
import { PostgresSessionStore } from "./postgres-session-store.ts";
import { PostgresTurnQueue } from "./postgres-turn-queue.ts";
import {
  githubInstallations,
  projects,
  repositoryFeedback,
  turnRequests,
  users,
} from "./schema.ts";
import { createProjectSession } from "./session-bootstrap.ts";
import { PostgresSessionNavigationStore } from "./session-navigation-store.ts";
import { PostgresSessionStartStore } from "./session-start-store.ts";

let writer: postgres.Sql;
let observer: postgres.Sql;
let db: PostgresJsDatabase;
let owner: string;
let nextInstallationId = 930_000;

beforeAll(async () => {
  writer = postgres(inject("postgresUrl"), { max: 4 });
  observer = postgres(inject("postgresUrl"), { max: 1 });
  await observer`select 1`;
  db = countingTransactions(drizzle(writer));
  const [user] = await db
    .insert(users)
    .values({ email: `${randomUUID()}@example.com`, name: "Lister" })
    .returning();
  owner = user?.id ?? "";
});

afterAll(async () => {
  await db.delete(repositoryFeedback);
  await db.delete(turnRequests).where(inArray(turnRequests.userId, [owner]));
  await db.delete(users).where(eq(users.id, owner));
  await writer.end();
  await observer.end();
});

/** Transactions open on `db` right now. */
let open = 0;
/** Announcements made while one was: each is a notice that could beat its own commit. */
const insideTransaction: SessionListOwner[][] = [];

afterEach(() => {
  expect(insideTransaction.splice(0)).toEqual([]);
});

/**
 * `base`, counting its open transactions. The count drops only once `transaction` has returned,
 * which is after the commit, so a store that announces from inside its callback is caught however
 * fast the commit that follows it is.
 */
function countingTransactions(base: PostgresJsDatabase): PostgresJsDatabase {
  return new Proxy(base, {
    get(target, property) {
      if (property === "transaction") {
        return async (...args: Parameters<PostgresJsDatabase["transaction"]>) => {
          open += 1;
          try {
            return await target.transaction(...args);
          } finally {
            open -= 1;
          }
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/**
 * An announcer that records whom each call named, and, if asked, a read another connection makes
 * at the moment of the call — started inside `announce`, so it goes out before the writer's next
 * statement could.
 */
function recording(read?: () => Promise<string | undefined>) {
  const calls: SessionListOwner[][] = [];
  const seen: Promise<string>[] = [];
  return {
    sessionList: {
      announce: (...owners: SessionListOwner[]) => {
        calls.push(owners);
        if (open > 0) insideTransaction.push(owners);
        if (read) seen.push(read().then((value) => value ?? "invisible"));
      },
    },
    calls,
    seen: () => Promise.all(seen),
  };
}

function requestState(id: string) {
  return async () =>
    (await observer<{ state: string }[]>`select state from turn_requests where id = ${id}`)[0]
      ?.state;
}

async function project() {
  return await createProjectSession(db, { userId: owner });
}

function turn(sessionId: string) {
  return {
    id: randomUUID(),
    sessionId,
    userId: owner,
    kind: "turn" as const,
    message: "add a toggle",
    model: "openai/gpt-5-mini",
    billsToUser: false,
  };
}

async function lease(id: string, leaseOwner: string, expiresIn = "1 minute") {
  await writer`
    update turn_requests
    set state = 'leased', lease_owner = ${leaseOwner}, lease_expires_at = now() + ${expiresIn}::interval,
      started_at = now()
    where id = ${id}
  `;
}

describe("PostgresTurnQueue", () => {
  it("announces a request queued, with the row already committed", async () => {
    const { sessionId } = await project();
    const request = turn(sessionId);
    const { sessionList, calls, seen } = recording(requestState(request.id));

    await new PostgresTurnQueue(db, { claims: null, sessionList }).enqueue(request);

    expect(calls).toEqual([[{ userId: owner }]]);
    expect(await seen()).toEqual(["queued"]);
  });

  it("announces a claim, with the row already leased", async () => {
    // Claimed by this queue alone would race whatever else the shared container holds, so the
    // request is the only one claimable: a fresh session, and `claim` skips nothing else here.
    const { sessionId } = await project();
    const request = turn(sessionId);
    await new PostgresTurnQueue(db, { claims: null }).enqueue(request);
    const { sessionList, calls, seen } = recording(requestState(request.id));
    const queue = new PostgresTurnQueue(db, { claims: null, sessionList });

    let claimed = await queue.claim("worker-1");
    // Rows another file left queued in the shared container may come first, and are left leased
    // to `worker-1`. Harmless only because db files run one at a time and the queue's own test
    // files empty `turn_requests` before they start.
    while (claimed !== null && claimed.id !== request.id) claimed = await queue.claim("worker-1");

    expect(claimed?.id).toBe(request.id);
    expect(calls.at(-1)).toEqual([{ userId: owner }]);
    expect((await seen()).at(-1)).toBe("leased");
  });

  it("announces a settle, with the row already settled, and not one that was not ours", async () => {
    const { sessionId } = await project();
    const request = turn(sessionId);
    await new PostgresTurnQueue(db, { claims: null }).enqueue(request);
    await lease(request.id, "worker-1");
    const { sessionList, calls, seen } = recording(requestState(request.id));
    const queue = new PostgresTurnQueue(db, { claims: null, sessionList });

    expect(await queue.settle(request.id, "somebody-else", "done")).toBe(false);
    expect(calls).toEqual([]);

    expect(await queue.settle(request.id, "worker-1", "done")).toBe(true);
    expect(calls).toEqual([[{ userId: owner }]]);
    expect(await seen()).toEqual(["done"]);
  });

  it("announces a cancel that failed a queued request, and not one that only flagged a run", async () => {
    const { sessionId } = await project();
    const queued = turn(sessionId);
    await new PostgresTurnQueue(db, { claims: null }).enqueue(queued);
    const { sessionList, calls } = recording();
    const queue = new PostgresTurnQueue(db, { claims: null, sessionList });

    await queue.requestCancel(sessionId);
    expect(calls).toEqual([[{ sessionId }]]);

    const other = await project();
    const running = turn(other.sessionId);
    await queue.enqueue(running);
    await lease(running.id, "worker-1");
    calls.length = 0;
    await queue.requestCancel(other.sessionId);
    expect(calls).toEqual([]);
  });

  it("announces the janitor reclaiming a lease, by its session", async () => {
    const { sessionId } = await project();
    const request = turn(sessionId);
    await new PostgresTurnQueue(db, { claims: null }).enqueue(request);
    await lease(request.id, "worker-that-died", "-1 hour");
    const { sessionList, calls } = recording();

    const queue = new PostgresTurnQueue(db, { claims: null, sessionList });
    await queue.orphanExpired();
    expect(calls.flat()).toContainEqual({ sessionId });

    // Again once the janitor has appended the turn's `turn.failed` and marked it finished, which
    // is when the card's time moves.
    calls.length = 0;
    await queue.markOrphanAnnounced(request.id);
    await queue.markOrphanAnnounced(request.id);
    expect(calls).toEqual([[{ userId: owner }], [{ userId: owner }]]);
  });

  it("announces a steer queued as a turn, and not one joining a running turn", async () => {
    const { sessionId } = await project();
    const { sessionList, calls } = recording();
    const queue = new PostgresTurnQueue(db, { claims: null, sessionList });
    const first = turn(sessionId);

    expect(await queue.steer(first)).toEqual({ as: "turn" });
    expect(calls).toEqual([[{ userId: owner }]]);

    await lease(first.id, "worker-1");
    calls.length = 0;
    expect((await queue.steer(turn(sessionId))).as).toBe("steer");
    expect(calls).toEqual([]);
  });
});

describe("creating a project", () => {
  it("announces a project started from the composer", async () => {
    const { sessionList, calls } = recording();
    const started = await new PostgresSessionStartStore(db, { claims: null, sessionList }).start({
      userId: owner,
      operationId: randomUUID(),
      fingerprint: "listed",
      name: "Build a page",
      source: { kind: "template" },
      request: { kind: "turn", message: "Build a page", model: "free-model", billsToUser: false },
    });
    expect(started.kind).toBe("created");
    expect(calls).toEqual([[{ userId: owner }]]);
  });

  it("announces a project created empty, once it has committed", async () => {
    const { sessionList, calls, seen } = recording(async () => {
      const [row] = await observer<{ n: number }[]>`
        select count(*)::int as n from projects where user_id = ${owner}
      `;
      return String(row?.n);
    });
    const before = (await db.select().from(projects).where(eq(projects.userId, owner))).length;

    await createProjectSession(db, { userId: owner }, { sessionList });

    expect(calls).toEqual([[{ userId: owner }]]);
    expect(await seen()).toEqual([String(before + 1)]);
  });
});

describe("a project's own record", () => {
  it("announces a rename and a delete, by owner, and not a rename that matched nothing", async () => {
    const { projectId } = await project();
    const { sessionList, calls } = recording();
    const store = new PostgresProjectStore(db, { sessionList });

    expect(await store.rename(projectId, owner, "Renamed")).toBe(true);
    expect(await store.rename(randomUUID(), owner, "Nothing")).toBe(false);
    expect(await store.delete(projectId, owner)).toBe(true);

    expect(calls).toEqual([[{ userId: owner }], [{ userId: owner }]]);
  });

  it("announces a title claimed, written and given up", async () => {
    const { projectId } = await project();
    const { sessionList, calls } = recording();
    const titles = new PostgresProjectTitleStore(db, { sessionList });

    const first = await titles.claim(projectId, owner, "manual");
    if (typeof first === "string") throw new Error(`claim refused: ${first}`);
    expect(await titles.apply(projectId, first.generation, "Habit Tracker", "manual")).toBe(true);
    // A second write with a spent generation matches nothing, and says nothing.
    expect(await titles.apply(projectId, first.generation, "Again", "manual")).toBe(false);
    await writer`update projects set title_requested_at = now() - interval '1 day' where id = ${projectId}`;
    const second = await titles.claim(projectId, owner, "manual");
    if (typeof second === "string") throw new Error(`claim refused: ${second}`);
    await titles.release(projectId, second.generation);

    expect(calls).toEqual([
      [{ userId: owner }],
      [{ projectId }],
      [{ userId: owner }],
      [{ projectId }],
    ]);
  });

  it("announces a workspace coming up and being put away", async () => {
    const { projectId, sessionId } = await project();
    const { sessionList, calls } = recording();

    await new PostgresSessionStore(db, { sessionList }).setSandboxId(sessionId, "sandbox-1");
    const sandboxes = new PostgresProjectSandboxStore(db, { sessionList });
    expect(await sandboxes.releaseSandbox(projectId, "another-sandbox", null)).toBe(false);
    expect(await sandboxes.releaseSandbox(projectId, "sandbox-1", null)).toBe(true);

    expect(calls).toEqual([[{ sessionId }], [{ userId: owner }]]);
  });
});

describe("PostgresSessionNavigationStore", () => {
  it("announces a change and a reorder that saved, and not one that conflicted", async () => {
    const { projectId } = await project();
    const { sessionList, calls } = recording();
    const store = new PostgresSessionNavigationStore(db, { sessionList });

    const pinned = await store.change(owner, projectId, {
      revision: 0,
      change: { kind: "pin", pinned: true },
    });
    expect(pinned.kind).toBe("saved");
    const stale = await store.change(owner, projectId, {
      revision: 0,
      change: { kind: "pin", pinned: false },
    });
    expect(stale.kind).toBe("conflict");
    const reordered = await store.reorder(owner, {
      section: "pinned",
      rows: [{ projectId, revision: 1 }],
    });
    expect(reordered.kind).toBe("saved");

    expect(calls).toEqual([[{ userId: owner }], [{ userId: owner }]]);
  });

  it("announces the sessions the reaper settled, by project", async () => {
    const { projectId } = await project();
    await new PostgresSessionNavigationStore(db).saveAutoSettleSettings(owner, {
      afterDays: 1,
      onMerge: false,
    });
    await writer`update projects set created_at = now() - interval '3 days', updated_at = now() - interval '3 days' where id = ${projectId}`;
    const { sessionList, calls } = recording();

    const settled = await new PostgresSessionNavigationStore(db, { sessionList }).autoSettle(
      10_000,
    );

    expect(settled).toContain(projectId);
    expect(calls.flat()).toContainEqual({ projectId });
  });
});

describe("PostgresGitHubStore", () => {
  async function installation() {
    const installationId = nextInstallationId++;
    await db.insert(githubInstallations).values({
      installationId,
      userId: owner,
      githubUserId: installationId,
      githubLogin: "owner",
      accountLogin: "repo-owner",
      accountType: "Organization",
      status: "active",
    });
    return installationId;
  }

  function importing(installationId: number, repositoryId: number): ImportRepository {
    return {
      userId: owner,
      installationId,
      name: "Imported app",
      repository: {
        id: repositoryId,
        fullName: "repo-owner/app",
        defaultBranch: "main",
        private: true,
      },
      baseBranch: "main",
      environment: { setupCommand: null, devCommand: null, previewPort: null },
      autoPublish: false,
    };
  }

  it("announces each change a card draws, and stays quiet on a refresh that moved nothing", async () => {
    const installationId = await installation();
    const repositoryId = nextInstallationId++;
    const { sessionList, calls } = recording();
    const store = new PostgresGitHubStore(db, { claims: null, sessionList });

    const imported = await store.importRepository(importing(installationId, repositoryId));
    if (imported === null) throw new Error("import refused");
    const { projectId, sessionId } = imported;
    expect(calls).toEqual([[{ userId: owner }]]);

    calls.length = 0;
    const job = await store.createJob({
      jobId: randomUUID(),
      projectId,
      sessionId,
      baseBranch: "main",
      headBranch: "nap/listed",
      baseSha: "a".repeat(40),
      headSha: null,
      pushedSha: null,
      pullRequestNumber: null,
      pullRequestUrl: null,
      pullRequestState: "none",
      publishState: "working",
      checkState: "unknown",
      reviewState: "unknown",
      error: null,
      updatedAt: new Date().toISOString(),
    });
    expect(calls).toEqual([[{ projectId }]]);

    calls.length = 0;
    const opened = {
      pullRequestNumber: 7,
      pullRequestUrl: "https://github.com/repo-owner/app/pull/7",
      pullRequestState: "open" as const,
    };
    await store.updateJob(job.jobId, opened);
    await store.updateJob(job.jobId, { ...opened, checkState: "passed" });
    await store.updateJob(job.jobId, { pullRequestState: "merged" });
    expect(calls).toEqual([[{ projectId }], [{ projectId }]]);

    calls.length = 0;
    const repository = importing(installationId, repositoryId).repository;
    await store.refreshRepository(installationId, repository);
    await store.refreshRepository(installationId, {
      ...repository,
      fullName: "repo-owner/renamed",
    });
    expect(calls).toEqual([[{ projectId }]]);

    calls.length = 0;
    const feedback = {
      id: randomUUID(),
      projectId,
      jobId: job.jobId,
      kind: "comment" as const,
      summary: "Please rename the button",
      requestId: null,
      createdAt: new Date().toISOString(),
    };
    expect(await store.addFeedback(feedback)).toBe(true);
    expect(await store.addFeedback(feedback)).toBe(false);
    expect(calls).toEqual([[{ projectId }]]);

    calls.length = 0;
    const approved = await store.approveFeedback(projectId, owner, feedback.id, turn(sessionId));
    expect(approved).not.toBeNull();
    expect(calls).toEqual([[{ userId: owner }]]);

    calls.length = 0;
    await store.addFeedback({ ...feedback, id: randomUUID() });
    calls.length = 0;
    await store.discardStaleFeedback(job.jobId, []);
    await store.discardStaleFeedback(job.jobId, []);
    expect(calls).toEqual([[{ projectId }]]);

    // A webhook closes the pull request while a refresh that read it merged is writing "merged"
    // back. The refresh does change the row — closed to merged — and must say so, though the job
    // it read before the webhook committed looked unchanged.
    calls.length = 0;
    const webhook = await writer.reserve();
    try {
      await webhook`begin`;
      await webhook`update repository_jobs set pull_request_state = 'closed' where job_id = ${job.jobId}`;
      const refresh = store.updateJob(job.jobId, { pullRequestState: "merged" });
      // Long enough for the refresh to be waiting on the webhook's row lock.
      await new Promise((resolve) => setTimeout(resolve, 200));
      await webhook`commit`;
      await refresh;
    } finally {
      webhook.release();
    }
    expect(calls).toEqual([[{ projectId }]]);
  });
});
