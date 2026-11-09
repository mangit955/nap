import { randomUUID } from "node:crypto";
import {
  ScriptedLLMProvider,
  type ScriptedResponse,
} from "@nap/agent/testing/scripted-llm-provider";
import { PostgresProjectStore } from "@nap/db/postgres-project-store";
import { PostgresProjectTitleStore } from "@nap/db/postgres-project-title-store";
import { projects, users } from "@nap/db/schema";
import { createProjectSession } from "@nap/db/session-bootstrap";
import { InMemoryEventBus } from "@nap/db/testing/in-memory-event-bus";
import { InMemoryEventStore } from "@nap/db/testing/in-memory-event-store";
import type { StoredEvent } from "@nap/shared/ports/event-store";
import type {
  LLMProvider,
  LLMRequest,
  LLMTurnOptions,
  LLMTurnResult,
} from "@nap/shared/ports/llm-provider";
import { eq, sql } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { SessionTitler, type TitleAccess } from "./session-titler.ts";

let connection: postgres.Sql;
let db: PostgresJsDatabase;
let owner: string;
const PROMPT = "build me a habit tracker where my team logs standups and sees streaks";
const TITLE = "Team Standup Streak Tracker";
const LUNA = "openai/gpt-5.6-luna";
const THEIR_KEY = { platform: "openrouter" as const, apiKey: "sk-or-theirs" };
const theirKey: TitleAccess = async () => ({ model: LUNA, credentials: THEIR_KEY });

beforeAll(async () => {
  connection = postgres(inject("postgresUrl"), { max: 3 });
  db = drizzle(connection);
  const [user] = await db
    .insert(users)
    .values({ email: `${randomUUID()}@example.com`, name: "Titler" })
    .returning();
  owner = user?.id ?? "";
});
afterAll(async () => {
  await db.delete(users).where(eq(users.id, owner));
  await connection.end();
});

function setup(provider: LLMProvider, access: TitleAccess = theirKey) {
  const events = new InMemoryEventStore();
  const bus = new InMemoryEventBus();
  const titler = new SessionTitler({
    store: new PostgresProjectTitleStore(db),
    provider,
    access,
    events,
    bus,
  });
  return { titler, events, bus };
}

/** A project named the way a first prompt names one: a seed, which a model title may replace. */
async function project(name = "Habit Tracker") {
  const created = await createProjectSession(db, { userId: owner });
  await db
    .update(projects)
    .set({ name, nameSource: "seed" })
    .where(eq(projects.id, created.projectId));
  return created;
}

async function stored(projectId: string) {
  const [row] = await db.select().from(projects).where(eq(projects.id, projectId));
  if (!row) throw new Error("Missing project");
  return row;
}

async function renamedEvents(events: InMemoryEventStore, sessionId: string) {
  return (await events.readFrom(sessionId, 0)).filter((event) => event.type === "project.renamed");
}

describe("an automatic title", () => {
  it("replaces the seed with the model's title, announces it and records what it cost", async () => {
    const provider = new ScriptedLLMProvider([
      [{ text: `"${TITLE}."`, usage: { inputTokens: 812, outputTokens: 7 } }],
    ]);
    const { titler, events, bus } = setup(provider);
    const created = await project();
    const heard: StoredEvent[] = [];
    bus.subscribe(created.sessionId, (event) => heard.push(event));

    const outcome = await titler.title({
      projectId: created.projectId,
      userId: owner,
      mode: "automatic",
      message: PROMPT,
    });

    expect(outcome).toEqual({ kind: "titled", name: TITLE });
    expect(await stored(created.projectId)).toMatchObject({
      name: TITLE,
      nameSource: "model",
      titleGeneration: null,
    });
    const [renamed] = await renamedEvents(events, created.sessionId);
    expect(renamed?.payload).toEqual({
      name: TITLE,
      source: "model",
      model: LUNA,
      usage: { inputTokens: 812, outputTokens: 7 },
    });
    expect(heard.map((event) => event.type)).toEqual(["project.renamed"]);
    // Paid for by the turn's own account, on the cheap model, asking for nothing but a line.
    expect(provider.turnOptions).toEqual([{ model: LUNA, credentials: THEIR_KEY }]);
    const [request] = provider.requests;
    expect(request).toMatchObject({ purpose: "title", maxOutputTokens: 64, tools: [] });
    expect(JSON.stringify(request?.messages)).toContain(PROMPT);
  });

  it.each<[string, ScriptedResponse | "throws", string]>([
    ["a refusal", { refusal: true }, "refused"],
    ["an error", { error: { message: "rate limited", retryable: true } }, "failed"],
    ["too short an answer", { text: "Streaks" }, "invalid"],
    [
      "an answer cut off by the output cap",
      { text: "Team Standup Streak", truncated: true },
      "invalid",
    ],
    ["a copy of the message", { text: "Build me a habit tracker" }, "invalid"],
    ["a provider that throws", "throws", "failed"],
  ])("keeps the seed, quietly, after %s", async (_name, response, reason) => {
    const provider = new ScriptedLLMProvider(response === "throws" ? [[]] : [[response]]);
    const { titler, events } = setup(provider);
    const created = await project();

    const outcome = await titler.title({
      projectId: created.projectId,
      userId: owner,
      mode: "automatic",
      message: PROMPT,
    });

    expect(outcome).toEqual({ kind: "kept", reason });
    expect(await stored(created.projectId)).toMatchObject({
      name: "Habit Tracker",
      nameSource: "seed",
      titleGeneration: null,
    });
    expect(await renamedEvents(events, created.sessionId)).toEqual([]);
  });

  it("keeps the seed when nobody can pay for it, and asks no model", async () => {
    const provider = new ScriptedLLMProvider([[{ text: TITLE }]]);
    const { titler } = setup(provider, async () => null);
    const created = await project();
    expect(
      await titler.title({
        projectId: created.projectId,
        userId: owner,
        mode: "automatic",
        message: PROMPT,
      }),
    ).toEqual({ kind: "kept", reason: "no_access" });
    expect(provider.requests).toEqual([]);
  });

  it("is written at most once per project, and never twice at once", async () => {
    // Two successful answers scripted, so a second request would be recorded and would land.
    const provider = new ScriptedLLMProvider([
      [{ text: TITLE }],
      [{ text: "Standup Streak Board App" }],
    ]);
    const { titler } = setup(provider);
    const created = await project();
    const request = {
      projectId: created.projectId,
      userId: owner,
      mode: "automatic" as const,
      message: PROMPT,
    };

    const outcomes = await Promise.all([titler.title(request), titler.title(request)]);
    expect(outcomes.map((outcome) => outcome.kind).sort()).toEqual(["busy", "titled"]);
    expect(provider.requests).toHaveLength(1);
    expect(await titler.title(request)).toEqual({ kind: "busy" });
    expect(provider.requests).toHaveLength(1);
  });

  it("never replaces a name the person chose", async () => {
    const provider = new ScriptedLLMProvider([[{ text: TITLE }]]);
    const { titler } = setup(provider);
    const created = await project();
    await new PostgresProjectStore(db).rename(created.projectId, owner, "My own name");
    expect(
      await titler.title({
        projectId: created.projectId,
        userId: owner,
        mode: "automatic",
        message: PROMPT,
      }),
    ).toEqual({ kind: "busy" });
    expect(provider.requests).toEqual([]);
    expect(await stored(created.projectId)).toMatchObject({
      name: "My own name",
      nameSource: "user",
    });
  });
});

/** A provider whose one answer waits until the test lets it go. */
class GatedProvider implements LLMProvider {
  release: (result: LLMTurnResult) => void = () => {};
  asked: Promise<void>;
  #asked: () => void = () => {};
  constructor() {
    this.asked = new Promise((resolve) => {
      this.#asked = resolve;
    });
  }
  startTurn(_options?: LLMTurnOptions) {
    return {
      complete: (_request: LLMRequest) =>
        new Promise<LLMTurnResult>((resolve) => {
          this.release = resolve;
          this.#asked();
        }),
      usage: () => ({ inputTokens: 0, outputTokens: 0 }),
    };
  }
}

describe("a rename while the title is being written", () => {
  it.each(["automatic", "manual"] as const)("wins over a %s title", async (mode) => {
    const provider = new GatedProvider();
    const { titler, events } = setup(provider);
    const created = await project();
    const pending = titler.title({
      projectId: created.projectId,
      userId: owner,
      mode,
      message: PROMPT,
    });
    await provider.asked;
    await new PostgresProjectStore(db).rename(created.projectId, owner, "What I typed");
    provider.release({
      type: "message",
      text: TITLE,
      toolCalls: [],
      usage: { inputTokens: 800, outputTokens: 6 },
    });

    expect(await pending).toEqual({ kind: "kept", reason: "renamed" });
    expect(await stored(created.projectId)).toMatchObject({
      name: "What I typed",
      nameSource: "user",
    });
    expect(await renamedEvents(events, created.sessionId)).toEqual([]);
  });
});

describe("regenerate", () => {
  it("rewrites even the person's own name when they ask, from their messages", async () => {
    const provider = new ScriptedLLMProvider([[{ text: TITLE }]]);
    const { titler } = setup(provider);
    const created = await project();
    await new PostgresProjectStore(db).rename(created.projectId, owner, "stuff");
    // The claim reads the person's messages from the real log, in Postgres.
    await db.execute(sql`
      insert into events (session_id, turn_id, seq, type, payload)
      values (${created.sessionId}, ${randomUUID()}, 1, 'user.message', ${JSON.stringify({ text: PROMPT })}::jsonb)
    `);

    expect(
      await titler.title({ projectId: created.projectId, userId: owner, mode: "manual" }),
    ).toEqual({ kind: "titled", name: TITLE });
    expect(await stored(created.projectId)).toMatchObject({ name: TITLE, nameSource: "model" });
    const prompt = JSON.stringify(provider.requests[0]?.messages);
    expect(prompt).toContain('previous title was \\"stuff\\"');
    expect(prompt).toContain(PROMPT);
    // Asked again at once: refused by the cooldown, which is not a title being written.
    expect(
      await titler.title({ projectId: created.projectId, userId: owner, mode: "manual" }),
    ).toEqual({ kind: "cooldown" });
    expect(provider.requests).toHaveLength(1);
  });

  it("has nothing to title in a session with no messages, and says so", async () => {
    const provider = new ScriptedLLMProvider([[{ text: TITLE }]]);
    const { titler } = setup(provider);
    const created = await project();
    expect(
      await titler.title({ projectId: created.projectId, userId: owner, mode: "manual" }),
    ).toEqual({ kind: "kept", reason: "nothing_to_title" });
    expect(provider.requests).toEqual([]);
  });
});
