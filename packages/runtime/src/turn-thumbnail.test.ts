import { FakePageCapture } from "@nap/capture/testing/fake-page-capture";
import { InMemorySandboxManager } from "@nap/sandbox/testing/in-memory-sandbox-manager";
import { InMemoryObjectStore } from "@nap/storage/testing/in-memory-object-store";
import { beforeEach, describe, expect, it } from "vitest";
import { captureThumbnail, thumbnailKey } from "./turn-thumbnail.ts";

/**
 * A picture of the running project, taken while it is still running.
 *
 * The rules pinned here are the ones a caller upstream depends on: the address is the one the
 * preview actually answers at, the bytes are the ones the browser produced, and **nothing is
 * stored when any step fails** — a half-written thumbnail is a broken picture on the dashboard
 * that nobody can tell from a broken app.
 */

const PROJECT_ID = "4d5e6f70-1a2b-4c3d-8e9f-0a1b2c3d4e5f";
const PORT = 5173;

let sandbox: InMemorySandboxManager;
let objects: InMemoryObjectStore;
let capture: FakePageCapture;
let sandboxId: string;

beforeEach(async () => {
  sandbox = new InMemorySandboxManager();
  objects = new InMemoryObjectStore();
  capture = new FakePageCapture();

  const created = await sandbox.create(PROJECT_ID);
  sandboxId = created.ok ? created.value.id : "";
  sandbox.listen(sandboxId, PORT);
});

const run = () =>
  captureThumbnail({ sandbox, capture, objects, projectId: PROJECT_ID, sandboxId, port: PORT });

describe("capturing a thumbnail", () => {
  it("photographs the address the preview answers at", async () => {
    const preview = await sandbox.getPreviewUrl(sandboxId, PORT);

    await run();

    expect(capture.requests.map((request) => request.url)).toEqual([preview.ok && preview.value]);
  });

  it("stores the bytes the browser produced, under the project's key", async () => {
    capture.returning(new Uint8Array([137, 80, 78, 71, 13]));

    const result = await run();

    expect(result).toMatchObject({ ok: true, value: { key: thumbnailKey(PROJECT_ID) } });
    const stored = await objects.get(thumbnailKey(PROJECT_ID));
    expect(stored.ok && [...stored.value]).toEqual([137, 80, 78, 71, 13]);
  });

  it("replaces the previous picture rather than keeping both", async () => {
    // Nothing refers to an old thumbnail and nothing can restore from one, so a second object
    // would be bytes nobody reads and somebody pays to keep.
    await run();
    await run();

    expect(objects.keys()).toEqual([thumbnailKey(PROJECT_ID)]);
  });
});

describe("when there is nothing to photograph", () => {
  it("stores nothing when the preview never answers", async () => {
    // Screenshotting the address anyway would put a picture of an error page on the dashboard,
    // which is indistinguishable from the user's app being broken.
    const idle = await sandbox.create(PROJECT_ID);
    const result = await captureThumbnail({
      sandbox,
      capture,
      objects,
      projectId: PROJECT_ID,
      sandboxId: idle.ok ? idle.value.id : "",
      port: PORT,
    });

    expect(result.ok).toBe(false);
    expect(capture.requests).toEqual([]);
    expect(objects.puts).toBe(0);
  });

  it("stores nothing when the capture fails", async () => {
    capture.failWith({ code: "timeout", message: "the page never settled" });

    const result = await run();

    expect(result).toMatchObject({ ok: false });
    expect(objects.puts).toBe(0);
  });

  it("reports an upload that failed", async () => {
    objects.failWith({ code: "unavailable", message: "R2 is down" });

    expect(await run()).toMatchObject({ ok: false, error: { message: /R2 is down/ } });
  });
});
