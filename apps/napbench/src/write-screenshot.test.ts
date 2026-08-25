import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CapturedScreenshot, parseScreenshotMetadata } from "@nap/bench/screenshot";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fileScreenshotStore } from "./write-screenshot.ts";

const RUN_ID = "3f2a1c4e-0000-4000-8000-000000000001";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function captured(overrides: Partial<CapturedScreenshot["metadata"]> = {}): CapturedScreenshot {
  return {
    metadata: {
      taskId: "todo",
      runId: RUN_ID,
      checkId: "shows-the-list",
      surface: null,
      viewport: { name: "mobile", width: 375, height: 667 },
      capturedAt: "2026-08-15T04:05:06.000Z",
      reference: null,
      ...overrides,
    },
    bytes: PNG,
  };
}

describe("fileScreenshotStore", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "napbench-shots-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes the image and returns a path relative to the results directory", async () => {
    const stored = await fileScreenshotStore(dir)(captured());

    expect(stored.ok).toBe(true);
    if (!stored.ok) return;

    // Relative, so an archived report survives the directory being moved.
    expect(stored.value).toBe(`todo-${RUN_ID}-shows-the-list.png`);
    expect(new Uint8Array(readFileSync(join(dir, stored.value)))).toEqual(PNG);
  });

  it("writes the metadata beside it, parseable on its own", async () => {
    const stored = await fileScreenshotStore(dir)(captured());
    if (!stored.ok) throw new Error(stored.error);

    const sidecar = readFileSync(join(dir, `${stored.value}.json`), "utf8");
    const parsed = parseScreenshotMetadata(JSON.parse(sidecar));

    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value).toEqual(captured().metadata);
  });

  it("keeps the reference the check declared", async () => {
    const store = fileScreenshotStore(dir);
    const stored = await store(captured({ reference: "refs/todo-mobile.png" }));
    if (!stored.ok) throw new Error(stored.error);

    const sidecar = JSON.parse(readFileSync(join(dir, `${stored.value}.json`), "utf8"));

    expect(sidecar.reference).toBe("refs/todo-mobile.png");
  });

  it("creates the results directory when it does not exist yet", async () => {
    // It is gitignored, so a fresh checkout has none — and a run that failed at the last step
    // for want of a mkdir has already spent the money.
    const nested = join(dir, "deeper", "still");

    expect((await fileScreenshotStore(nested)(captured())).ok).toBe(true);
  });

  it("reports a write it could not do rather than throwing", async () => {
    // A screenshot is evidence about a run, not an observation of the application, so the
    // runner must be able to carry on. A file where the directory needs to be forces the case.
    const blocked = join(dir, "blocked");
    writeFileSync(blocked, "not a directory");

    const stored = await fileScreenshotStore(blocked)(captured());

    expect(stored.ok).toBe(false);
    if (!stored.ok) expect(stored.error.length).toBeGreaterThan(0);
  });

  it("keeps two checks in one run apart on disk", async () => {
    const store = fileScreenshotStore(dir);

    const first = await store(captured({ checkId: "shows-the-list" }));
    const second = await store(captured({ checkId: "filters-completed" }));
    if (!first.ok || !second.ok) throw new Error("both writes should have succeeded");

    expect(first.value).not.toBe(second.value);
    expect(readFileSync(join(dir, second.value))).toBeDefined();
  });
});
