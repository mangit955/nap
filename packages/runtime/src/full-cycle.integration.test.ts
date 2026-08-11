/**
 * A project's whole life, once: create → turn → put away → restore → second turn.
 *
 * Every piece of this is proven on its own elsewhere — the bundle round trip against real git,
 * the R2 adapter against a real bucket, each Postgres store against a real database. What none
 * of them can say is whether the pieces still fit when they are wired together, and that seam
 * is what `docs/PLAN.md` §4 asks this one test to hold.
 *
 * **The stores are real, and that is load-bearing rather than thorough.** A sandbox belongs to
 * a *project*, so `PostgresSessionStore` and `PostgresProjectSandboxStore` read and write the
 * same `projects.sandbox_id` column, while their in-memory counterparts keep two independent
 * maps. On the fakes, putting the project away would leave the session still pointing at a
 * destroyed sandbox: the second turn would take the resume-failure path, restore *with* a
 * warning, and the assertion that matters most here — that a reopened project says nothing to
 * the user, because nothing went wrong — would be asserting the opposite of the truth.
 *
 * **The model is scripted, and that is deliberate too.** What has to be provable is that the
 * second turn finds the first turn's work, which needs a turn that changes a file we can name.
 * A real model makes that a hope rather than an assertion, and it is not the thing under test:
 * the request shape belongs to the provider's own integration test, and the loop to the CLI
 * harness. So this run costs sandbox seconds and a handful of objects, and no model call.
 */

import { NapAgentService } from "@nap/agent/agent-service";
import { ScriptedLLMProvider } from "@nap/agent/testing/scripted-llm-provider";
import { NapContextEngine } from "@nap/context/context-engine";
import { NoopMemoryProvider } from "@nap/context/noop-memory-provider";
import { createDatabase } from "@nap/db/client";
import { InProcessEventBus } from "@nap/db/in-process-event-bus";
import { PostgresEventStore } from "@nap/db/postgres-event-store";
import { PostgresProjectSandboxStore } from "@nap/db/postgres-project-sandbox-store";
import { PostgresSessionStore } from "@nap/db/postgres-session-store";
import { PostgresSnapshotStore } from "@nap/db/postgres-snapshot-store";
import { users } from "@nap/db/schema";
import { createProjectSession } from "@nap/db/session-bootstrap";
import { expectEventSequence } from "@nap/db/testing/event-assertions";
import { type MigratedPostgres, startMigratedPostgres } from "@nap/db/testing/postgres-container";
import { E2BSandboxManager } from "@nap/sandbox/e2b-sandbox-manager";
import { NAP_TEMPLATE, TEMPLATE_WORKDIR } from "@nap/sandbox/template";
import type { StoredEvent } from "@nap/shared/ports/event-store";
import type { TurnOutcome } from "@nap/shared/ports/runtime";
import { createR2Client, R2ObjectStore } from "@nap/storage/r2-object-store";
import { afterAll, beforeAll, expect, it } from "vitest";
import { type SweepResult, sweepIdleProjects } from "./reaper.ts";
import { SingleAgentRuntime } from "./single-agent-runtime.ts";

// Thrown rather than skipped. This is the milestone's acceptance test, and "green end to end"
// is not something a suite that quietly ran nothing can report.
const missing = [
  "E2B_API_KEY",
  "R2_ACCOUNT_ID",
  "R2_BUCKET",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
].filter((name) => !process.env[name]);

if (missing.length > 0) {
  throw new Error(
    `${missing.join(", ")} not set, so the full cycle cannot run. ` +
      "Put them in apps/api/.env, then re-run `bun run test:integration`.",
  );
}

const r2 = {
  accountId: process.env.R2_ACCOUNT_ID ?? "",
  bucket: process.env.R2_BUCKET ?? "",
  accessKeyId: process.env.R2_ACCESS_KEY_ID ?? "",
  secretAccessKey: process.env.R2_SECRET_ACCESS_KEY ?? "",
};

/** What the first turn writes, and the second turn reads back out of a different sandbox. */
const SURVIVOR = `${TEMPLATE_WORKDIR}/src/Survivor.tsx`;
const SURVIVOR_CONTENTS =
  "export function Survivor() {\n  return <p>I came back from a snapshot.</p>;\n}\n";

/** What the second turn adds, proving the restored repository still takes commits. */
const SEQUEL = `${TEMPLATE_WORKDIR}/src/Sequel.tsx`;
const SEQUEL_CONTENTS = "export function Sequel() {\n  return <p>And then this happened.</p>;\n}\n";

const FIRST_MESSAGE = "Add a Survivor component";
const SECOND_MESSAGE = "Read Survivor and add a Sequel beside it";

/**
 * The dev server has to answer before `preview.ready` is emitted, and its absence would change
 * the event sequence rather than fail the turn. Three times the template's measured cold start,
 * so a slow one costs seconds instead of a confusing diff.
 */
const PREVIEW_TIMEOUT_MS = 60_000;

const sandbox = new E2BSandboxManager({ template: NAP_TEMPLATE });
const objects = new R2ObjectStore(createR2Client(r2));

/** Every sandbox this file caused to exist, so a failure part-way through still cleans up. */
const created: string[] = [];

let database: MigratedPostgres;
let closeDatabase: () => Promise<void>;

let projectId: string;
let sessionId: string;
let firstSandboxId: string;
let secondSandboxId: string;
let firstOutcome: TurnOutcome;
let secondOutcome: TurnOutcome;
let sweep: SweepResult;
let snapshotKey: string;
/**
 * Every key this run wrote, collected while the rows still exist.
 *
 * The database is a throwaway container and takes its rows with it, so the bucket is the only
 * thing here that outlives the process — and the rows are the only record of which objects
 * belong to this run. Since a turn now snapshots itself, there are several rather than one, and
 * deleting only the newest would leave the rest orphaned in a real bucket on every run.
 */
let writtenKeys: string[] = [];
let log: StoredEvent[];
let restoredGitLog: string;

/** The events of one turn, in the order they were appended. */
function turnEvents(turnId: string): StoredEvent[] {
  return log.filter((event) => event.turnId === turnId);
}

function outputOf(events: StoredEvent[], toolName: string): string {
  const result = events.find(
    (event) => event.type === "tool.result" && event.payload.toolName === toolName,
  );
  if (result === undefined || result.type !== "tool.result") {
    throw new Error(`no tool.result for ${toolName} in this turn`);
  }
  return result.payload.output;
}

beforeAll(async () => {
  database = await startMigratedPostgres();
  const connection = createDatabase(database.url, { max: 4 });
  const db = connection.db;
  closeDatabase = connection.close;

  // A real owner row, since a project's `user_id` is a foreign key and nothing invents one.
  const [user] = await db
    .insert(users)
    .values({ email: `${crypto.randomUUID()}@example.com`, name: "Full cycle" })
    .returning();
  const owner = user?.id ?? "";

  const sessions = new PostgresSessionStore(db);
  const projects = new PostgresProjectSandboxStore(db);
  const snapshots = new PostgresSnapshotStore(db);
  const events = new PostgresEventStore(db);

  ({ projectId, sessionId } = await createProjectSession(db, {
    userId: owner,
    name: "Full cycle",
  }));

  const runtime = new SingleAgentRuntime({
    sessions,
    sandbox,
    objects,
    snapshots,
    events,
    bus: new InProcessEventBus(),
    context: new NapContextEngine({ budgetTokens: 40_000 }),
    memory: new NoopMemoryProvider(),
    previewTimeoutMs: PREVIEW_TIMEOUT_MS,
    agent: new NapAgentService({
      budget: { maxSteps: 4 },
      provider: new ScriptedLLMProvider([
        [
          {
            toolCalls: [
              {
                id: "write_survivor",
                name: "write_file",
                input: { path: SURVIVOR, contents: SURVIVOR_CONTENTS },
              },
            ],
          },
          { text: "Added the Survivor component." },
        ],
        [
          { toolCalls: [{ id: "read_survivor", name: "read_file", input: { path: SURVIVOR } }] },
          {
            toolCalls: [
              {
                id: "write_sequel",
                name: "write_file",
                input: { path: SEQUEL, contents: SEQUEL_CONTENTS },
              },
            ],
          },
          { text: "Read Survivor and added Sequel." },
        ],
      ]),
    }),
  });

  firstOutcome = await runtime.runTurn({ sessionId, message: FIRST_MESSAGE });
  firstSandboxId = (await sessions.get(sessionId))?.sandboxId ?? "";
  if (firstSandboxId === "") throw new Error("the first turn recorded no sandbox");
  created.push(firstSandboxId);

  // The automatic path rather than `putProjectAway` directly, so the idleness query runs against
  // a real database too. Everything in this container is this test's, and its only project has
  // just gone quiet, so a zero threshold selects exactly it.
  sweep = await sweepIdleProjects({
    projects,
    sandbox,
    objects,
    snapshots,
    idleMs: 0,
    isBusy: () => false,
  });

  snapshotKey = (await snapshots.latestFor(projectId))?.key ?? "";

  secondOutcome = await runtime.runTurn({ sessionId, message: SECOND_MESSAGE });
  secondSandboxId = (await sessions.get(sessionId))?.sandboxId ?? "";
  if (secondSandboxId === "") throw new Error("the second turn recorded no sandbox");
  created.push(secondSandboxId);

  const history = await sandbox.exec(
    secondSandboxId,
    `cd ${TEMPLATE_WORKDIR} && git log --format=%s`,
  );
  if (!history.ok) throw new Error(`could not read the restored history: ${history.error.message}`);
  restoredGitLog = history.value.stdout;

  log = await events.readFrom(sessionId, 0);

  // Read here, not in `afterAll` — by then the container is on its way out.
  writtenKeys = (await snapshots.listFor(projectId)).map((row) => row.key);
}, 300_000);

afterAll(async () => {
  for (const sandboxId of created) await sandbox.destroy(sandboxId);
  for (const key of writtenKeys) await objects.delete(key);
  await closeDatabase?.();
  await database?.stop();
}, 120_000);

it("runs a first turn in a sandbox it created, and commits it", () => {
  expect(firstOutcome.ok).toBe(true);
  if (!firstOutcome.ok) return;
  expect(firstOutcome.commitSha).not.toBeNull();

  // `preview.ready` before `turn.started`: the runtime announces the sandbox it just made
  // before handing it to the agent, and `file.changed` lands between a tool's call and its
  // result because the tool emits it as it writes.
  expectEventSequence(turnEvents(firstOutcome.turnId), [
    "user.message",
    "preview.ready",
    "turn.started",
    "tool.call",
    "file.changed",
    "tool.result",
    "agent.message",
    "turn.completed",
  ]);
});

it("puts the project away into the real bucket", async () => {
  expect(sweep).toMatchObject({ reaped: [projectId], failed: [], abandoned: [] });
  expect(snapshotKey).not.toBe("");

  // The row is not the snapshot. Only fetching the bytes distinguishes a project that was
  // stored from one that was merely recorded as stored.
  const stored = await objects.get(snapshotKey);

  expect(stored.ok).toBe(true);
  if (!stored.ok) return;
  expect(stored.value.byteLength).toBeGreaterThan(0);
});

it("opens the second turn in a new sandbox, the first one having really gone", async () => {
  expect(secondSandboxId).not.toBe(firstSandboxId);

  expect(secondOutcome.ok).toBe(true);
  if (!secondOutcome.ok) return;
  expect(secondOutcome.commitSha).not.toBeNull();

  // The interesting half. Dropping the reference is bookkeeping and a new sandbox appears
  // either way; the point of putting a project away is that nothing is left running to be
  // billed for, and only asking the provider can tell the two apart.
  expect(await sandbox.exec(firstSandboxId, "true")).toMatchObject({
    ok: false,
    error: { code: "destroyed" },
  });
});

it("restores without telling the user anything went wrong", () => {
  expect(secondOutcome.ok).toBe(true);
  if (!secondOutcome.ok) return;

  // Nothing went wrong, so there is nothing to say. A `system.notice` here means the session
  // was still pointing at the destroyed sandbox and the turn recovered by falling back —
  // which reaches the same place, having lost anything since the snapshot.
  const notices = turnEvents(secondOutcome.turnId).filter(
    (event) => event.type === "system.notice",
  );

  expect(notices).toEqual([]);
});

it("hands the second turn the file the first turn wrote", () => {
  expect(secondOutcome.ok).toBe(true);
  if (!secondOutcome.ok) return;
  const events = turnEvents(secondOutcome.turnId);

  // Read through the tool, in the restored sandbox, by the agent — not by this test reaching
  // past the runtime into a filesystem.
  expect(outputOf(events, "read_file")).toBe(SURVIVOR_CONTENTS);

  expectEventSequence(events, [
    "user.message",
    "preview.ready",
    "turn.started",
    "tool.call",
    "tool.result",
    "tool.call",
    "file.changed",
    "tool.result",
    "agent.message",
    "turn.completed",
  ]);
});

it("restores a repository that still has its history and still takes commits", () => {
  const subjects = restoredGitLog.trim().split("\n");

  // Newest first: the second turn committed into the restored repository, on top of the first
  // turn's commit, on top of whatever the template started with.
  expect(subjects[0]).toBe(SECOND_MESSAGE);
  expect(subjects[1]).toBe(FIRST_MESSAGE);
  expect(subjects.length).toBeGreaterThan(2);
});

it("writes both turns into one unbroken log", () => {
  // The sandbox changed underneath the session; the sequence numbering did not.
  expect(log.map((event) => event.seq)).toEqual(log.map((_, index) => index + 1));
  expect(new Set(log.map((event) => event.turnId)).size).toBe(2);
});
