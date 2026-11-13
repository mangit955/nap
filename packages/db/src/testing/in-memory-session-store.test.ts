import { UNTITLED_PROJECT } from "@nap/shared/project-title";
import { describe, expect, it } from "vitest";
import { FAKE_OWNER, InMemoryProjectStore } from "./in-memory-project-store.ts";
import { InMemorySessionStore } from "./in-memory-session-store.ts";

const SESSION = "2a3f8a24-6c1b-4e0e-9b6f-3a5c0a1d9e77";
const PROJECT = "4d5e6f70-1a2b-4c3d-8e9f-0a1b2c3d4e5f";
const SANDBOX = "sbx-1";

describe("InMemorySessionStore", () => {
  it("returns null for a session it was never given", async () => {
    expect(await new InMemorySessionStore().get(SESSION)).toBeNull();
  });

  it("returns a seeded session with no sandbox yet", async () => {
    const store = new InMemorySessionStore([{ sessionId: SESSION, projectId: PROJECT }]);

    expect(await store.get(SESSION)).toStrictEqual({
      sessionId: SESSION,
      projectId: PROJECT,
      // Defaulted to the shared fake owner, so the record is complete without every turn test
      // having to name a user it does not care about.
      userId: FAKE_OWNER,
      sandboxId: null,
      // A new project's name, which is what a session seeded without one belongs to.
      projectName: UNTITLED_PROJECT,
    });
  });

  it("reads the project's name from a project store it is given, as the real join does", async () => {
    // Two fakes holding two copies of one name would disagree the moment a test renamed the
    // project through one of them. Linked, the session's view follows the project's.
    const projects = new InMemoryProjectStore([
      {
        projectId: PROJECT,
        name: "Habit tracker",
        status: "idle",
        sandboxId: null,
        updatedAt: "2026-08-09T11:00:00.000Z",
        sessionIds: [SESSION],
      },
    ]);
    const store = new InMemorySessionStore([{ sessionId: SESSION, projectId: PROJECT }], {
      projects,
    });

    expect((await store.get(SESSION))?.projectName).toBe("Habit tracker");
    await projects.rename(PROJECT, FAKE_OWNER, "Renamed");
    expect((await store.get(SESSION))?.projectName).toBe("Renamed");
  });

  it("takes a seeded name when it is given no project store", async () => {
    const store = new InMemorySessionStore([
      { sessionId: SESSION, projectId: PROJECT, projectName: "Habit tracker" },
    ]);

    expect((await store.get(SESSION))?.projectName).toBe("Habit tracker");
  });

  it("remembers a recorded sandbox id", async () => {
    const store = new InMemorySessionStore([{ sessionId: SESSION, projectId: PROJECT }]);

    await store.setSandboxId(SESSION, SANDBOX);

    expect((await store.get(SESSION))?.sandboxId).toBe(SANDBOX);
  });

  it("throws when asked to record a sandbox for an unknown session", async () => {
    // A programmer error, not an outcome: the caller looked the session up first.
    await expect(new InMemorySessionStore().setSandboxId(SESSION, SANDBOX)).rejects.toThrow(
      /unknown session/i,
    );
  });

  it("hands out copies, so a caller cannot mutate the stored record", async () => {
    const store = new InMemorySessionStore([{ sessionId: SESSION, projectId: PROJECT }]);

    const record = await store.get(SESSION);
    if (record === null) throw new Error("expected a record");
    record.sandboxId = "tampered";

    expect((await store.get(SESSION))?.sandboxId).toBeNull();
  });
});
