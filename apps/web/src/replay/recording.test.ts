import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_ROOT_PATH } from "@nap/shared/files-protocol";
import { describe, expect, it } from "vitest";
import { FEATURED_REPLAY_PATH } from "./featured.ts";
import { buildAt, filesAt, listingAt, MAX_GAP_MS, playbackOffsets } from "./playback.ts";
import type { ReplayRecording } from "./recording.ts";
import { findReplay, replaySlugs } from "./replays.ts";

const PUBLIC = join(import.meta.dirname, "../../public");

function recordings(): ReplayRecording[] {
  return replaySlugs().map((slug) => {
    const recording = findReplay(slug);
    if (!recording) throw new Error(`no replay ${slug}`);
    return recording;
  });
}

function projectPath(path: string): string {
  return path.startsWith(`${PROJECT_ROOT_PATH}/`) ? path.slice(PROJECT_ROOT_PATH.length + 1) : path;
}

describe.each(recordings())("the $slug replay", (recording) => {
  it("holds a whole session that ended verified", () => {
    expect(recording.events[0]?.type).toBe("user.message");
    expect(recording.events.at(-1)).toMatchObject({
      type: "job.completed",
      payload: { outcome: "verified" },
    });
  });

  // The revisions are worked out when a recording is made, not from the log, so this is what
  // proves they are the files the agent actually had: every time it read a whole file, what it
  // was shown must be what the replay holds for that file at that moment.
  it("holds the files the agent read, as it read them", () => {
    const calls = new Map(
      recording.events.flatMap((event) =>
        event.type === "tool.call" && event.payload.toolName === "read_file"
          ? [[event.payload.toolCallId, event.payload.input] as const]
          : [],
      ),
    );
    let compared = 0;
    for (const event of recording.events) {
      if (event.type !== "tool.result" || !event.payload.ok) continue;
      const input = calls.get(event.payload.toolCallId);
      if (!input || typeof input !== "object" || "offset" in input || "limit" in input) continue;
      const path = projectPath(String((input as { path: unknown }).path));
      expect(filesAt(recording, event.seq).get(path), path).toBe(event.payload.output);
      compared++;
    }
    expect(compared).toBeGreaterThan(0);
  });

  it("announces every revision with a change to the same file", () => {
    for (const revision of recording.revisions) {
      const event = recording.events[revision.seq - 1];
      expect(event?.type).toBe("file.changed");
      if (event?.type === "file.changed")
        expect(projectPath(event.payload.path)).toBe(revision.path);
    }
  });

  it("serves every build from this deployment's own files", () => {
    for (const build of recording.builds) {
      expect(existsSync(join(PUBLIC, build.path)), build.path).toBe(true);
      // Asset paths relative to the page, so the build works under its folder rather than at /.
      expect(readFileSync(join(PUBLIC, build.path), "utf8")).not.toMatch(/(src|href)="\/assets/);
    }
  });

  it("carries no address, key or home directory of anyone", () => {
    const text = JSON.stringify(recording);
    // A letter top-level domain, so `nap-app@0.0.0` in a build log is not an address.
    expect(text).not.toMatch(/[\w.+-]+@[\w-]+(\.[\w-]+)*\.[a-z]{2,}\b/i);
    expect(text).not.toMatch(/sk-[\w-]{16,}|ghp_\w{20,}|Bearer\s+\w{16,}/);
    expect(text).not.toMatch(/\/Users\/|\/home\/(?!user\/app)/);
  });

  it("plays in under two minutes", () => {
    expect(playbackOffsets(recording.events).at(-1)).toBeLessThan(120_000);
  });
});

it("sends the front page to a replay that exists", () => {
  expect(replaySlugs().map((slug) => `/replay/${slug}`)).toContain(FEATURED_REPLAY_PATH);
});

describe("playback", () => {
  const at = (seconds: number) => new Date(Date.UTC(2026, 7, 25, 18, 0, seconds)).toISOString();
  const event = (seq: number, seconds: number) =>
    ({
      type: "agent.thinking",
      payload: { text: "." },
      sessionId: "82310376-63dd-4442-b4e1-3cb5b56c888b",
      turnId: "cd0020a9-b9a6-4c1c-8ab7-46ee8593c967",
      seq,
      createdAt: at(seconds),
    }) as const;

  it("keeps recorded gaps and shortens only the long ones", () => {
    expect(playbackOffsets([event(1, 0), event(2, 1), event(3, 20), event(4, 21)])).toEqual([
      0,
      1000,
      1000 + MAX_GAP_MS,
      2000 + MAX_GAP_MS,
    ]);
  });

  it("never runs the clock backwards on events written out of order", () => {
    expect(playbackOffsets([event(1, 5), event(2, 4)])).toEqual([0, 0]);
  });

  it("lays each revision over the files from its seq on", () => {
    const recording = findReplay("reading-list");
    if (!recording) throw new Error("missing");
    const [first] = recording.revisions;
    if (!first) throw new Error("no revisions");
    expect(filesAt(recording, first.seq - 1).get(first.path)).toBe(recording.files[first.path]);
    expect(filesAt(recording, first.seq).get(first.path)).toBe(first.contents);
    expect(listingAt(recording, 1).files).toEqual(Object.keys(recording.files).sort());
  });

  it("shows no build before the session's preview came up", () => {
    const recording = findReplay("reading-list");
    if (!recording) throw new Error("missing");
    const first = recording.builds[0]?.fromSeq ?? 1;
    expect(buildAt(recording, first - 1)).toBeUndefined();
    expect(buildAt(recording, recording.events.length)?.path).toBe(recording.builds.at(-1)?.path);
  });
});
