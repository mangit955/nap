import {
  COMPACTION_HISTORY_DIR,
  compactionHistoryPath,
  renderCompactionHistory,
} from "@nap/context/compaction-history";
import { InMemorySandboxManager } from "@nap/sandbox/testing/in-memory-sandbox-manager";
import type { NapEvent } from "@nap/shared/events";
import { beforeEach, describe, expect, it } from "vitest";
import { compactionHistoryFile } from "./compaction-history.ts";

const SESSION = "00000000-0000-4000-8000-000000000001";
const TURN = "00000000-0000-4000-8000-00000000000a";
const PATH = compactionHistoryPath(SESSION);

let seq = 0;
function event(body: Pick<NapEvent, "type" | "payload">): NapEvent {
  seq += 1;
  return {
    sessionId: SESSION,
    turnId: TURN,
    seq,
    createdAt: "2026-11-01T00:00:00.000Z",
    ...body,
  } as NapEvent;
}
function checkpoint(coveredThrough: number): NapEvent {
  return event({
    type: "compaction.completed",
    payload: {
      id: crypto.randomUUID(),
      result: { kind: "api", checkpoint: { coveredThrough, summary: "s", tail: [] } },
      usage: null,
      beforeTokens: 1,
      afterTokens: 1,
    },
  });
}

/** Counts writes, so "already current" can be told apart from "rewritten identically". */
class CountingSandbox extends InMemorySandboxManager {
  writes: string[] = [];
  override async writeFile(sandboxId: string, path: string, contents: string) {
    this.writes.push(path);
    return super.writeFile(sandboxId, path, contents);
  }
}

let sandbox: CountingSandbox;
let sandboxId: string;
let history: NapEvent[];

beforeEach(async () => {
  seq = 0;
  sandbox = new CountingSandbox();
  const created = await sandbox.create("project");
  if (!created.ok) throw new Error(created.error.message);
  sandboxId = created.value.id;
  history = [
    event({ type: "user.message", payload: { text: "Keep it purple." } }),
    event({ type: "agent.message", payload: { text: "Made it purple." } }),
  ];
  history.push(checkpoint(2));
});

const file = (id = sandboxId) =>
  compactionHistoryFile({ sandbox, sandboxId: id, sessionId: SESSION });
const read = async (id = sandboxId) => {
  const contents = await sandbox.readFile(id, PATH);
  return contents.ok ? contents.value : undefined;
};

describe("the compaction history in a sandbox", () => {
  it("writes nothing for a session that has never been compacted", async () => {
    expect(await file().sync(history.slice(0, 2))).toBeUndefined();
    expect(sandbox.writes).toEqual([]);
  });

  it("writes the rendering of the log, outside the project", async () => {
    expect(await file().sync(history)).toBe(PATH);
    expect(await read()).toBe(renderCompactionHistory(history, SESSION));
    expect(PATH.startsWith(`${COMPACTION_HISTORY_DIR}/`)).toBe(true);
    const project = await sandbox.listFiles(sandboxId, "/home/user/app");
    expect(project.ok && project.value.some((node) => node.path.includes(".nap"))).toBe(false);
  });

  it("leaves a current file alone", async () => {
    await file().sync(history);
    sandbox.writes = [];
    expect(await file().sync(history)).toBe(PATH);
    expect(sandbox.writes).toEqual([]);
  });

  it("regenerates the same file in a sandbox that never had it", async () => {
    await file().sync(history);
    const original = await read();
    const replacement = await sandbox.create("project");
    if (!replacement.ok) throw new Error(replacement.error.message);
    expect(await read(replacement.value.id)).toBeUndefined();
    expect(await file(replacement.value.id).sync(history)).toBe(PATH);
    expect(await read(replacement.value.id)).toBe(original);
  });

  it("rewrites a file that is behind the log, and the new one extends the old", async () => {
    await file().sync(history);
    const before = await read();
    history.push(event({ type: "user.message", payload: { text: "Add a filter." } }));
    history.push(event({ type: "agent.message", payload: { text: "Filter added." } }));
    history.push(checkpoint(5));
    expect(await file().sync(history)).toBe(PATH);
    const after = await read();
    expect(after?.startsWith(before ?? "missing")).toBe(true);
    expect(after).toContain("    Add a filter.");
  });

  it("rewrites the file when its record survived but the file did not", async () => {
    // A write recorded for a file that is no longer there: removed by a command, say.
    const replacement = await sandbox.create("project");
    if (!replacement.ok) throw new Error(replacement.error.message);
    await file().sync(history);
    const listed = await sandbox.listFiles(sandboxId, COMPACTION_HISTORY_DIR);
    for (const node of listed.ok ? listed.value : [])
      if (node.path !== PATH) {
        const record = await sandbox.readFile(sandboxId, node.path);
        if (record.ok) await sandbox.writeFile(replacement.value.id, node.path, record.value);
      }
    expect(await file(replacement.value.id).sync(history)).toBe(PATH);
    expect(await read(replacement.value.id)).toBe(renderCompactionHistory(history, SESSION));
  });

  it("writes a boundary the log has not committed yet, and the next sync replaces it", async () => {
    const pending = [...history, event({ type: "agent.message", payload: { text: "More." } })];
    expect(await file().write(pending, [2, 4])).toBe(true);
    expect(await read()).toContain("==== Part 2: events #3 to #4 ====");
    // The compaction that wrote part 2 never committed, so the log still ends at part 1.
    expect(await file().sync(pending)).toBe(PATH);
    expect(await read()).toBe(renderCompactionHistory(pending, SESSION));
    expect(await read()).not.toContain("Part 2");
  });

  it("reports a sandbox it could not write to instead of pointing at nothing", async () => {
    expect(await file("missing-sandbox").sync(history)).toBeUndefined();
    expect(await file("missing-sandbox").write(history, [2])).toBe(false);
  });
});
