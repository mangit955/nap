/**
 * Every Postgres write that can make a turn request claimable announces it, after it commits.
 *
 * An idle worker no longer asks the queue every tenth of a second: it waits for one of these, with
 * a poll seconds apart behind it for the ones that get lost. So a writer that forgets to announce
 * does not break anything a test of that writer would notice — the request is still claimed, a few
 * seconds late, every time. This file is what notices. `test/claim-writers.test.ts` is its
 * tripwire: a new file that inserts into `turn_requests` fails there until it announces.
 *
 * **After the commit, never inside the transaction**, and each test checks it from the outside: the
 * announcer reads the row on a connection of its own the moment it is called. A worker woken by an
 * announcement asks the queue at once, so one sent before the commit would find nothing, go back to
 * sleep and leave the request waiting for the fallback poll — the very delay this exists to remove.
 */

import { randomUUID } from "node:crypto";
import type { ImportRepository } from "@nap/shared/ports/github-store";
import { eq, inArray } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { PostgresGitHubStore } from "./github-store.ts";
import { PostgresTurnQueue } from "./postgres-turn-queue.ts";
import { githubInstallations, repositoryFeedback, turnRequests, users } from "./schema.ts";
import { createProjectSession } from "./session-bootstrap.ts";
import { PostgresSessionStartStore } from "./session-start-store.ts";

let writer: postgres.Sql;
let observer: postgres.Sql;
let db: PostgresJsDatabase;
let owner: string;
let nextInstallationId = 910_000;

beforeAll(async () => {
  writer = postgres(inject("postgresUrl"), { max: 4 });
  // Another connection, so what it reads is what any other process would: committed rows only.
  observer = postgres(inject("postgresUrl"), { max: 1 });
  await observer`select 1`;
  db = drizzle(writer);
  const [user] = await db
    .insert(users)
    .values({ email: `${randomUUID()}@example.com`, name: "Announcer" })
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

/**
 * An announcer that records, at the moment it is called, the states another connection can see.
 *
 * Synchronous to call, as the port is, so the read is started inside `announce` and awaited later:
 * the query goes out before the writer's next statement could, which is what makes "the row was
 * already committed" a statement about the moment of the announcement.
 */
function watching(read: () => Promise<string | undefined>) {
  const seen: Promise<string>[] = [];
  return {
    claims: { announce: () => void seen.push(read().then((state) => state ?? "invisible")) },
    seen: () => Promise.all(seen),
  };
}

/** The request's state as another process would read it. */
function stateOf(id: string) {
  return async () =>
    (await observer<{ state: string }[]>`select state from turn_requests where id = ${id}`)[0]
      ?.state;
}

/** For a test that expects no announcement at all, and so has nothing to read. */
const nothing = async () => undefined;

async function session() {
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

/** Leased by id rather than by `claim`, because the shared container may hold others' rows. */
async function lease(id: string, leaseOwner: string, expiresIn = "1 minute") {
  await writer`
    update turn_requests
    set state = 'leased', lease_owner = ${leaseOwner}, lease_expires_at = now() + ${expiresIn}::interval
    where id = ${id}
  `;
}

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

function importing(installationId: number): ImportRepository {
  return {
    userId: owner,
    installationId,
    name: "Imported app",
    repository: {
      id: nextInstallationId++,
      fullName: "repo-owner/app",
      defaultBranch: "main",
      private: true,
    },
    baseBranch: "main",
    environment: { setupCommand: null, devCommand: null, previewPort: null },
    autoPublish: false,
  };
}

describe("PostgresTurnQueue", () => {
  it("announces an enqueue, with the row already queued", async () => {
    const { sessionId } = await session();
    const request = turn(sessionId);
    const { claims, seen } = watching(stateOf(request.id));

    await new PostgresTurnQueue(db, { claims }).enqueue(request);

    expect(await seen()).toEqual(["queued"]);
  });

  it("announces a steer queued as a turn only after it commits", async () => {
    const { sessionId } = await session();
    const request = turn(sessionId);
    const { claims, seen } = watching(stateOf(request.id));
    const queue = new PostgresTurnQueue(db, { claims });

    expect(await queue.steer(request)).toEqual({ as: "turn" });
    expect(await seen()).toEqual(["queued"]);
    expect(await queue.steer(request)).toEqual({ as: "turn" });
    expect(await seen()).toEqual(["queued"]);
  });

  it("announces deferred steers after commit, but not a steer joining a turn", async () => {
    const { sessionId } = await session();
    const request = turn(sessionId);
    const quiet = new PostgresTurnQueue(db, { claims: null });
    await quiet.enqueue(request);
    await lease(request.id, "worker-1");
    const steer = turn(sessionId);
    const { claims, seen } = watching(stateOf(steer.id));
    const queue = new PostgresTurnQueue(db, { claims });

    expect(await queue.steer(steer)).toEqual({ as: "steer", requestId: request.id });
    expect(await seen()).toEqual([]);
    expect(await queue.close(request.id, "worker-1", "defer")).toEqual({
      deferred: [{ id: steer.id, text: steer.message }],
      dropped: [],
    });
    expect(await seen()).toEqual(["queued"]);
    await queue.close(request.id, "worker-1", "defer");
    expect(await seen()).toEqual(["queued"]);
  });

  it("announces a settle, with the session's lease already given back", async () => {
    const { sessionId } = await session();
    const request = turn(sessionId);
    await new PostgresTurnQueue(db, { claims: null }).enqueue(request);
    await lease(request.id, "worker-1");
    const { claims, seen } = watching(stateOf(request.id));
    const queue = new PostgresTurnQueue(db, { claims });

    expect(await queue.settle(request.id, "somebody-else", "done")).toBe(false);
    expect(await seen()).toEqual([]);

    expect(await queue.settle(request.id, "worker-1", "done")).toBe(true);
    expect(await seen()).toEqual(["done"]);
  });

  it("announces the janitor reclaiming a lease, once it is reclaimed", async () => {
    const { sessionId } = await session();
    const request = turn(sessionId);
    await new PostgresTurnQueue(db, { claims: null }).enqueue(request);
    await lease(request.id, "worker-that-died", "-1 hour");
    const { claims, seen } = watching(stateOf(request.id));

    const orphaned = await new PostgresTurnQueue(db, { claims }).orphanExpired();

    expect(orphaned.map((row) => row.id)).toContain(request.id);
    expect(await seen()).toEqual(["orphaned"]);
  });

  it("announces nothing when the janitor found nothing to reclaim", async () => {
    // Every tick of a healthy deployment, so an announcement here would be a wake-up per tick.
    await new PostgresTurnQueue(db, { claims: null }).orphanExpired();
    const { claims, seen } = watching(nothing);

    expect(await new PostgresTurnQueue(db, { claims }).orphanExpired()).toEqual([]);

    expect(await seen()).toEqual([]);
  });

  it("is not told about a cancel, which never makes anything claimable", async () => {
    // A queued request is failed outright, and a leased one is only flagged: the lease is given back
    // by the worker's settle, which announces for itself.
    const { sessionId } = await session();
    const request = turn(sessionId);
    await new PostgresTurnQueue(db, { claims: null }).enqueue(request);
    const { claims, seen } = watching(stateOf(request.id));

    await new PostgresTurnQueue(db, { claims }).requestCancel(sessionId);

    expect(await seen()).toEqual([]);
  });
});

describe("PostgresSessionStartStore", () => {
  it("announces the first turn of a new project, with the row already queued", async () => {
    const operationId = randomUUID();
    // By operation, because the request's id is the store's to choose and is not known until
    // `start` returns — after the announcement this is checking.
    const { claims, seen } = watching(
      async () =>
        (
          await observer<{ state: string }[]>`
            select r.state from turn_requests r
            join session_starts s on s.request_id = r.id
            where s.operation_id = ${operationId}
          `
        )[0]?.state,
    );
    const store = new PostgresSessionStartStore(db, { claims });

    const started = await store.start({
      userId: owner,
      operationId,
      fingerprint: "announced",
      name: "Build a page",
      source: { kind: "template" },
      request: { kind: "turn", message: "Build a page", model: "free-model", billsToUser: false },
    });
    expect(started.kind).toBe("created");
    expect(await seen()).toEqual(["queued"]);
  });

  it("announces nothing for a start that admitted nothing", async () => {
    const { claims, seen } = watching(nothing);
    const store = new PostgresSessionStartStore(db, { claims });
    const input = {
      userId: owner,
      operationId: randomUUID(),
      fingerprint: "first",
      name: "Build a page",
      source: { kind: "template" as const },
      request: {
        kind: "turn" as const,
        message: "Build a page",
        model: "free-model",
        billsToUser: false,
      },
    };
    await new PostgresSessionStartStore(db, { claims: null }).start(input);

    expect(await store.start({ ...input, fingerprint: "changed" })).toEqual({ kind: "conflict" });

    expect(await seen()).toEqual([]);
  });
});

describe("PostgresGitHubStore", () => {
  it("announces an import that opens the project, with its resume already queued", async () => {
    const open = { requestId: randomUUID(), model: "test-model" };
    const { claims, seen } = watching(stateOf(open.requestId));

    const imported = await new PostgresGitHubStore(db, { claims }).importRepository({
      ...importing(await installation()),
      open,
    });

    expect(imported).not.toBeNull();
    expect(await seen()).toEqual(["queued"]);
  });

  it("announces nothing for an import that queued nothing", async () => {
    const { claims, seen } = watching(nothing);

    await new PostgresGitHubStore(db, { claims }).importRepository(importing(await installation()));

    expect(await seen()).toEqual([]);
  });

  it("announces approved feedback, with its turn already queued", async () => {
    const quiet = new PostgresGitHubStore(db, { claims: null });
    const repository = await quiet.importRepository(importing(await installation()));
    if (repository === null) throw new Error("expected an import");
    const jobId = randomUUID();
    await quiet.createJob({
      jobId,
      projectId: repository.projectId,
      sessionId: repository.sessionId,
      baseBranch: repository.baseBranch,
      headBranch: `nap/${jobId}`,
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
    const feedbackId = `comment:${randomUUID()}`;
    await quiet.addFeedback({
      id: feedbackId,
      projectId: repository.projectId,
      jobId,
      kind: "comment",
      summary: "Please fix the failing check.",
      requestId: null,
      createdAt: new Date().toISOString(),
    });
    const request = turn(repository.sessionId);
    const { claims, seen } = watching(stateOf(request.id));

    const queued = await new PostgresGitHubStore(db, { claims }).approveFeedback(
      repository.projectId,
      owner,
      feedbackId,
      request,
    );

    expect(queued).toBe(request.id);
    expect(await seen()).toEqual(["queued"]);
  });
});
