import { InMemoryEventBus } from "@nap/db/testing/in-memory-event-bus";
import { InMemoryEventStore } from "@nap/db/testing/in-memory-event-store";
import { InMemorySessionStore } from "@nap/db/testing/in-memory-session-store";
import { TEMPLATE_WORKDIR } from "@nap/sandbox/template";
import { InMemorySandboxManager } from "@nap/sandbox/testing/in-memory-sandbox-manager";
import { FileContentSchema, FileListingSchema } from "@nap/shared/files-protocol";
import type { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { createLogger } from "../logger.ts";
import { MAX_FILE_BYTES } from "./routes.ts";

/**
 * Everything here dispatches through `app.request()` against the same fake sandbox the rest
 * of the workspace tests with, so the routes are exercised end to end with no network, no
 * container and no cost — the testing strategy in docs/PLAN.md §3.
 */

const SESSION = "0b7f8f1e-3c2a-4d5b-9e6f-1a2b3c4d5e6f";
const EMPTY_SESSION = "1c8e9a2f-4d3b-4e6c-8f7a-2b3c4d5e6f70";
const silent = () => createLogger({ level: "silent" }, { write: () => {} });

let sandbox: InMemorySandboxManager;
let sandboxId: string;

async function seedProject(files: Record<string, string>): Promise<string> {
  const created = await sandbox.create("project-1");
  if (!created.ok) throw new Error("could not create a sandbox");

  for (const [path, contents] of Object.entries(files)) {
    await sandbox.writeFile(created.value.id, `${TEMPLATE_WORKDIR}/${path}`, contents);
  }
  return created.value.id;
}

function app(): Hono {
  return createApp({
    logger: silent(),
    stream: {
      store: new InMemoryEventStore(),
      bus: new InMemoryEventBus(),
      upgradeWebSocket: async () => new Response(null),
    },
    files: {
      sessions: new InMemorySessionStore([
        { sessionId: SESSION, projectId: "project-1", sandboxId },
        { sessionId: EMPTY_SESSION, projectId: "project-2" },
      ]),
      sandbox,
    },
  });
}

beforeEach(async () => {
  sandbox = new InMemorySandboxManager();
  sandboxId = await seedProject({
    "index.html": "<!doctype html>",
    "package.json": "{}",
    "src/App.tsx": "export default function App() {\n  return null;\n}\n",
    "src/components/Header.tsx": "export const Header = () => null;\n",
    "node_modules/react/index.js": "module.exports = {};",
  });
});

describe("GET /sessions/:sessionId/files", () => {
  it("lists the project's files, relative to its root", async () => {
    const res = await app().request(`/sessions/${SESSION}/files`);

    expect(res.status).toBe(200);
    expect(FileListingSchema.parse(await res.json())).toEqual({
      ready: true,
      files: ["index.html", "package.json", "src/App.tsx", "src/components/Header.tsx"],
      truncated: false,
    });
  });

  it("reports a session with no sandbox as not ready rather than as an error", async () => {
    // Before the first turn there is nothing to list. A 404 here would put a failure in the
    // pane of a project whose owner has not done anything wrong yet.
    const res = await app().request(`/sessions/${EMPTY_SESSION}/files`);

    expect(res.status).toBe(200);
    expect(FileListingSchema.parse(await res.json())).toEqual({
      ready: false,
      files: [],
      truncated: false,
    });
  });

  it("404s for a session that does not exist", async () => {
    const unknown = "2d9fab30-5e4c-4f7d-9a8b-3c4d5e6f7081";
    const res = await app().request(`/sessions/${unknown}/files`);

    expect(res.status).toBe(404);
  });

  it("400s for a session id that is not a uuid", async () => {
    const res = await app().request("/sessions/nope/files");

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: expect.any(String) });
  });

  it("503s when the sandbox is gone", async () => {
    // Distinguishable from "no sandbox yet" on purpose: this one is a project the user had.
    await sandbox.destroy(sandboxId);

    const res = await app().request(`/sessions/${SESSION}/files`);

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({ error: expect.any(String) });
  });
});

describe("GET /sessions/:sessionId/file", () => {
  it("returns a file's contents", async () => {
    const res = await app().request(`/sessions/${SESSION}/file?path=src/App.tsx`);

    expect(res.status).toBe(200);
    expect(FileContentSchema.parse(await res.json())).toEqual({
      path: "src/App.tsx",
      contents: "export default function App() {\n  return null;\n}\n",
      truncated: false,
      bytes: 49,
    });
  });

  it("reports the size in bytes, not in characters", async () => {
    // A file of emoji takes four bytes per character. Reporting its length instead would tell
    // someone their file is a quarter of the size it actually takes up.
    const contents = "const wave = '👋👋👋';\n";
    await sandbox.writeFile(sandboxId, `${TEMPLATE_WORKDIR}/emoji.ts`, contents);

    const res = await app().request(`/sessions/${SESSION}/file?path=emoji.ts`);
    const body = FileContentSchema.parse(await res.json());

    expect(body.bytes).toBeGreaterThan(body.contents.length);
    expect(body.bytes).toBe(Buffer.byteLength(contents, "utf8"));
  });

  it("truncates a large file and says how big the whole thing is", async () => {
    const line = `${"x".repeat(79)}\n`;
    const huge = line.repeat(Math.ceil((MAX_FILE_BYTES * 2) / line.length));
    await sandbox.writeFile(sandboxId, `${TEMPLATE_WORKDIR}/big.txt`, huge);

    const res = await app().request(`/sessions/${SESSION}/file?path=big.txt`);
    const body = FileContentSchema.parse(await res.json());

    expect(body.truncated).toBe(true);
    expect(body.bytes).toBe(huge.length);
    expect(body.contents.length).toBeLessThanOrEqual(MAX_FILE_BYTES);
    // Cut on a line boundary: half a line of source renders as a syntax error the user did
    // not write, and the viewer numbers lines.
    expect(body.contents.endsWith("\n")).toBe(true);
  });

  it("404s for a file that is not there", async () => {
    const res = await app().request(`/sessions/${SESSION}/file?path=src/Missing.tsx`);

    expect(res.status).toBe(404);
  });

  it.each([
    ["no path at all", ""],
    ["an absolute path", "/etc/passwd"],
    ["a path climbing out of the project", "../../etc/passwd"],
    ["a path climbing out from inside", "src/../../../etc/passwd"],
  ])("400s for %s, rather than asking the sandbox", async (_name, path) => {
    // 400 rather than 404 is the assertion that matters. A path that reached the filesystem
    // would come back as a missing file, which reads as "nothing there" — and on a sandbox
    // where something *is* there at that path, as a served file.
    const res = await app().request(`/sessions/${SESSION}/file?path=${encodeURIComponent(path)}`);

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: expect.any(String) });
  });
});

describe("when the app is built without file dependencies", () => {
  it("has no file routes at all", async () => {
    // Boot does not wire these yet: it has no SessionStore. Registering the routes anyway
    // would answer a real request with a 500 from a missing dependency.
    const unwired = createApp({
      logger: silent(),
      stream: {
        store: new InMemoryEventStore(),
        bus: new InMemoryEventBus(),
        upgradeWebSocket: async () => new Response(null),
      },
    });

    const res = await unwired.request(`/sessions/${SESSION}/files`);

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({ error: expect.any(String) });
  });
});
