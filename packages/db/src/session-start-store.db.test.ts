import { randomUUID } from "node:crypto";
import type { AdmittedSessionStart } from "@nap/shared/ports/session-start-store";
import { and, eq } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, expect, inject, it } from "vitest";
import {
  githubInstallations,
  projectRepositories,
  projects,
  turnRequests,
  users,
} from "./schema.ts";
import { PostgresSessionStartStore } from "./session-start-store.ts";

let connection: postgres.Sql;
let db: PostgresJsDatabase;
let store: PostgresSessionStartStore;
let owner: string;
beforeAll(async () => {
  connection = postgres(inject("postgresUrl"), { max: 3 });
  db = drizzle(connection);
  store = new PostgresSessionStartStore(db);
  const [user] = await db
    .insert(users)
    .values({ email: `${randomUUID()}@example.com`, name: "Session starter" })
    .returning();
  owner = user?.id ?? "";
});
afterAll(async () => {
  await db.delete(users).where(eq(users.id, owner));
  await connection.end();
});
it("atomically creates and admits once across concurrent retries, even after the request ends", async () => {
  const operationId = randomUUID();
  const input = {
    userId: owner,
    operationId,
    fingerprint: "same-input",
    name: "Build a page",
    source: { kind: "template" as const },
    request: {
      kind: "turn" as const,
      message: "Build a page",
      target: { kind: "api" as const, model: "free-model", billsToUser: false },
      attachments: [],
    },
  };
  const [first, retry] = await Promise.all([store.start(input), store.start(input)]);
  expect(first).toEqual(retry);
  expect(first.kind).toBe("created");
  if (first.kind !== "created") throw new Error("Session was not created");
  expect(
    await db
      .select()
      .from(projects)
      .where(and(eq(projects.userId, owner), eq(projects.id, first.projectId))),
  ).toHaveLength(1);
  expect(
    await db.select().from(turnRequests).where(eq(turnRequests.sessionId, first.sessionId)),
  ).toHaveLength(1);
  await db.update(turnRequests).set({ state: "done" }).where(eq(turnRequests.id, first.requestId));
  expect(await store.start(input)).toEqual(first);
  expect(await store.start({ ...input, fingerprint: "changed-input" })).toEqual({
    kind: "conflict",
  });
  expect(await store.find(randomUUID(), operationId)).toBeNull();
});

it("commits imported media with its source, survives revoked-access retries, and never recreates a deleted receipt", async () => {
  const installationId = 987654;
  await db.insert(githubInstallations).values({
    installationId,
    userId: owner,
    githubUserId: 7,
    githubLogin: "reader",
    accountLogin: "northstar-labs",
    accountType: "Organization",
    status: "active",
  });
  const input: AdmittedSessionStart = {
    userId: owner,
    operationId: randomUUID(),
    fingerprint: "imported-media",
    name: "Refine calendar",
    source: {
      kind: "github",
      import: {
        userId: owner,
        installationId,
        name: "Calendar",
        repository: {
          id: 345,
          fullName: "northstar-labs/calendar",
          defaultBranch: "main",
          private: true,
        },
        baseBranch: "main",
        environment: { setupCommand: null, devCommand: null, previewPort: null },
        autoPublish: false,
      },
    },
    request: {
      kind: "turn",
      message: "Refine the calendar",
      target: { kind: "api" as const, model: "openai/gpt-5.6-luna", billsToUser: false },
      attachments: [
        {
          kind: "image",
          name: "calendar.jpg",
          frames: [{ data: "aGVsbG8=", mediaType: "image/jpeg", timestamp: 0 }],
        },
      ],
    },
  };
  const first = await store.start(input);
  if (first.kind !== "created") throw new Error("Import failed");
  const [binding] = await db
    .select()
    .from(projectRepositories)
    .where(eq(projectRepositories.projectId, first.projectId));
  expect(binding?.repository).toMatchObject({ id: 345 });
  const requests = await db
    .select()
    .from(turnRequests)
    .where(eq(turnRequests.sessionId, first.sessionId));
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({
    kind: "turn",
    message: input.request.message,
    target: input.request.target,
    attachments: input.request.attachments,
  });
  await db
    .update(githubInstallations)
    .set({ status: "disconnected" })
    .where(eq(githubInstallations.installationId, installationId));
  expect(await store.start(input)).toEqual(first);
  expect(await store.start({ ...input, operationId: randomUUID() })).toEqual({
    kind: "access_changed",
  });
  await db.delete(projects).where(eq(projects.id, first.projectId));
  expect(await store.start(input)).toEqual({ kind: "deleted" });
});
