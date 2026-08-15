import { describe, expect, it } from "vitest";
import {
  parseScreenshotMetadata,
  refFromMetadata,
  ScreenshotRefSchema,
  screenshotFilename,
  screenshotMetadataFilename,
} from "./screenshot.ts";

const RUN_ID = "0f9c1c2e-8b3a-4d5e-9f10-1a2b3c4d5e6f";

const metadata = {
  taskId: "todo-crud",
  runId: RUN_ID,
  checkId: "adds-a-todo",
  viewport: { name: "mobile" as const, width: 375, height: 667 },
  capturedAt: "2026-08-15T04:05:06.000Z",
  reference: null,
};

describe("screenshotFilename", () => {
  it("names the file by task, run and check, so a listing is readable and unique", () => {
    expect(screenshotFilename(metadata)).toBe(`todo-crud-${RUN_ID}-adds-a-todo.png`);
  });

  it("puts the metadata beside the image under the same stem", () => {
    // The pair is found from either side by name alone. Nothing stores a pointer from one to
    // the other, for the same reason a report carries no path to its trajectory: a path baked
    // into an archived artefact is wrong the first time somebody moves the directory.
    expect(screenshotMetadataFilename(metadata)).toBe(`todo-crud-${RUN_ID}-adds-a-todo.png.json`);
  });

  it("keeps two runs of one task from overwriting each other", () => {
    const other = { ...metadata, runId: "11111111-2222-3333-4444-555555555555" };

    expect(screenshotFilename(other)).not.toBe(screenshotFilename(metadata));
  });

  it("keeps two checks in one run from overwriting each other", () => {
    const other = { ...metadata, checkId: "filters-completed" };

    expect(screenshotFilename(other)).not.toBe(screenshotFilename(metadata));
  });
});

describe("refFromMetadata", () => {
  it("carries what a report needs and drops what it already says", () => {
    // The report knows its own task and run, so repeating them per screenshot would be three
    // copies of one fact that a hand-edited file could put out of step.
    expect(refFromMetadata(metadata, "todo-crud-x-adds-a-todo.png")).toEqual({
      checkId: "adds-a-todo",
      viewport: { name: "mobile", width: 375, height: 667 },
      path: "todo-crud-x-adds-a-todo.png",
      capturedAt: "2026-08-15T04:05:06.000Z",
    });
  });
});

describe("parseScreenshotMetadata", () => {
  it("round-trips what was written", () => {
    const parsed = parseScreenshotMetadata(JSON.parse(JSON.stringify(metadata)));

    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value).toEqual(metadata);
  });

  it("refuses a capture with no size, which is what makes an image interpretable", () => {
    const { viewport: _dropped, ...withoutViewport } = metadata;

    expect(parseScreenshotMetadata(withoutViewport).ok).toBe(false);
  });

  it("refuses a timestamp that is not a timestamp", () => {
    expect(parseScreenshotMetadata({ ...metadata, capturedAt: "yesterday" }).ok).toBe(false);
  });

  it("refuses an unknown field, so a typo cannot become a silently ignored one", () => {
    expect(parseScreenshotMetadata({ ...metadata, viewpoint: "mobile" }).ok).toBe(false);
  });
});

describe("ScreenshotMetadataSchema — what it refuses", () => {
  it("accepts a null viewport name, for a size that is none of ours", () => {
    const parsed = parseScreenshotMetadata({
      ...metadata,
      viewport: { name: null, width: 800, height: 900 },
    });

    expect(parsed.ok).toBe(true);
  });

  it("refuses an id that would write outside the results directory", () => {
    // Task ids come from hand-written modules, so this is a typo rather than an attack — but a
    // slash would put the image somewhere the report's relative path does not point.
    expect(parseScreenshotMetadata({ ...metadata, checkId: "../escape" }).ok).toBe(false);
    expect(parseScreenshotMetadata({ ...metadata, taskId: "a/b" }).ok).toBe(false);
    expect(parseScreenshotMetadata({ ...metadata, checkId: ".." }).ok).toBe(false);
  });

  it("still accepts the ordinary shape of an id", () => {
    expect(parseScreenshotMetadata({ ...metadata, checkId: "adds_a-todo.2" }).ok).toBe(true);
  });
});

describe("ScreenshotRefSchema — the relative-path rule, enforced", () => {
  const ref = {
    checkId: "adds-a-todo",
    viewport: { name: "mobile" as const, width: 375, height: 667 },
    path: "todo-x-adds-a-todo.png",
    capturedAt: "2026-08-15T04:05:06.000Z",
  };

  it("accepts a relative path", () => {
    expect(ScreenshotRefSchema.safeParse(ref).success).toBe(true);
  });

  it("refuses an absolute one, which is what stops a report being portable", () => {
    expect(ScreenshotRefSchema.safeParse({ ...ref, path: "/tmp/shot.png" }).success).toBe(false);
    expect(ScreenshotRefSchema.safeParse({ ...ref, path: "C:\\shots\\a.png" }).success).toBe(false);
  });

  it("refuses one that climbs out of the directory", () => {
    expect(ScreenshotRefSchema.safeParse({ ...ref, path: "../elsewhere.png" }).success).toBe(false);
  });
});
