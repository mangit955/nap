import { InMemorySandboxManager } from "@nap/sandbox/testing/in-memory-sandbox-manager";
import type { PendingEvent } from "@nap/shared/ports/event-store";
import { beforeEach, describe, expect, it } from "vitest";
import type { ToolContext } from "./context.ts";
import { DEFAULT_READ_LINES, PROJECT_ROOT } from "./definitions.ts";
import { executeTool } from "./execute.ts";
import { MAX_LINE_CHARS, numbered } from "./files.ts";
import { FileLedger } from "./ledger.ts";

const APP = `${PROJECT_ROOT}/src/App.tsx`;

let manager: InMemorySandboxManager;
let sandboxId: string;
let events: PendingEvent[];
let ledger: FileLedger;

beforeEach(async () => {
  manager = new InMemorySandboxManager();
  const created = await manager.create("project");
  if (!created.ok) throw new Error(created.error.message);
  sandboxId = created.value.id;
  events = [];
  ledger = new FileLedger();
});

function context(): ToolContext {
  return {
    sessionId: "2a3f8a24-6c1b-4e0e-9b6f-3a5c0a1d9e77",
    turnId: "7c9b1a52-8d3e-4f21-a0c4-1b2d3e4f5a6b",
    sandboxId,
    sandbox: manager,
    ledger,
    emit: (event) => events.push(event as PendingEvent),
  };
}

function run(name: string, input: Record<string, unknown>) {
  return executeTool({ id: `toolu_${name}`, name, input }, context());
}

describe("numbered", () => {
  it("numbers lines from the offset and pads them to one width", () => {
    const text = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n");
    expect(numbered(text, 9, 3)).toBe(
      " 9\tline 9\n10\tline 10\n11\tline 11\n… 1 more lines. Read on with offset 12.",
    );
  });

  it("does not invent an empty last line for a file ending in a newline", () => {
    expect(numbered("a\nb\n", 1)).toBe("1\ta\n2\tb");
  });

  it("says so for an empty file and for an offset past the end", () => {
    expect(numbered("", 1)).toBe("(empty file)");
    expect(numbered("a\n", 5)).toBe("The file has 1 lines; offset 5 is past the end.");
  });

  it("cuts a line too long to be source and says how much it cut", () => {
    const output = numbered("x".repeat(MAX_LINE_CHARS + 10), 1);
    expect(output).toBe(`1\t${"x".repeat(MAX_LINE_CHARS)}… (10 more characters)`);
  });

  it("stops at the default window and points at the rest", () => {
    const text = Array.from({ length: DEFAULT_READ_LINES + 5 }, () => "x").join("\n");
    expect(numbered(text, 1)).toMatch(/… 5 more lines\. Read on with offset 2001\.$/);
  });
});

describe("read_file", () => {
  it("reads a window of a file when asked", async () => {
    await manager.writeFile(sandboxId, APP, "one\ntwo\nthree\nfour\n");
    const result = await run("read_file", { path: APP, offset: 2, limit: 2 });
    expect(result.output).toBe("2\ttwo\n3\tthree\n… 1 more lines. Read on with offset 4.");
  });
});

describe("the rule that a file is read before it changes", () => {
  it("applies a unique exact edit to a file this turn has not read", async () => {
    // The match is the guard: text that is still there, once, is what the model meant.
    await manager.writeFile(sandboxId, APP, "const a = 1;\n");

    const result = await run("edit_file", {
      path: APP,
      old_string: "const a = 1;",
      new_string: "const a = 2;",
    });

    expect(result.ok).toBe(true);
    expect(await manager.readFile(sandboxId, APP)).toEqual({ ok: true, value: "const a = 2;\n" });
    expect(events.filter((event) => event.type === "file.changed")).toHaveLength(1);
  });

  it.each([false, true])(
    "refuses non-UTF8 edits without changing bytes, even when the file is known: %s",
    async (known) => {
      const before = Uint8Array.from([255, 0, ...new TextEncoder().encode("old-marker")]);
      await manager.writeFileBytes(sandboxId, APP, before);
      if (known) await run("read_file", { path: APP });

      const result = await run("edit_file", {
        path: APP,
        old_string: "old-marker",
        new_string: "new-marker",
      });

      expect(result.ok).toBe(false);
      expect(await manager.readFileBytes(sandboxId, APP)).toEqual({ ok: true, value: before });
      expect(events.filter((event) => event.type === "file.changed")).toEqual([]);
    },
  );

  it("preserves the UTF8 BOM and unmatched Unicode bytes when editing an unread file", async () => {
    const before = "\uFEFFconst name = 'café';\n\uFFFD\u0000 keep\n";
    await manager.writeFileBytes(sandboxId, APP, new TextEncoder().encode(before));

    const result = await run("edit_file", {
      path: APP,
      old_string: "café",
      new_string: "你好",
    });

    expect(result.ok).toBe(true);
    expect(await manager.readFileBytes(sandboxId, APP)).toEqual({
      ok: true,
      value: new TextEncoder().encode("\uFEFFconst name = '你好';\n\uFFFD\u0000 keep\n"),
    });
    expect(events.filter((event) => event.type === "file.changed")).toHaveLength(1);
  });

  it("refuses a stale edit to an unread file with the guidance to read it, and changes nothing", async () => {
    await manager.writeFile(sandboxId, APP, "const a = 3;\n");

    const result = await run("edit_file", {
      path: APP,
      old_string: "const a = 1;",
      new_string: "const a = 2;",
    });

    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/Nothing in .* matches[\s\S]*Read the file/);
    expect(await manager.readFile(sandboxId, APP)).toEqual({ ok: true, value: "const a = 3;\n" });
    expect(events.filter((event) => event.type === "file.changed")).toEqual([]);
  });

  it("refuses replace_all on a file this turn has not read, and changes nothing", async () => {
    // How many matches there are now is exactly what an unread file can have changed.
    await manager.writeFile(sandboxId, APP, "red red red\n");

    const result = await run("edit_file", {
      path: APP,
      old_string: "red",
      new_string: "blue",
      replace_all: true,
    });

    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/Read .* before replacing every occurrence/);
    expect(await manager.readFile(sandboxId, APP)).toEqual({ ok: true, value: "red red red\n" });
    expect(events.filter((event) => event.type === "file.changed")).toEqual([]);
  });

  it("asks for more context, or a read before replace_all, when an unread file has several matches", async () => {
    await manager.writeFile(sandboxId, APP, "red red\n");

    const result = await run("edit_file", { path: APP, old_string: "red", new_string: "blue" });

    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/appears 2 times.*read the file.*replace_all/i);
    expect(await manager.readFile(sandboxId, APP)).toEqual({ ok: true, value: "red red\n" });
  });

  it("does not count a file it edited unread as known: overwriting it still needs a read", async () => {
    await manager.writeFile(sandboxId, APP, "const a = 1;\nprecious\n");
    const edited = await run("edit_file", {
      path: APP,
      old_string: "const a = 1;",
      new_string: "const a = 2;",
    });

    const overwritten = await run("write_file", { path: APP, contents: "replaced\n" });
    const all = await run("edit_file", {
      path: APP,
      old_string: "a",
      new_string: "b",
      replace_all: true,
    });

    expect([edited.ok, overwritten.ok, all.ok]).toEqual([true, false, false]);
    expect(overwritten.output).toMatch(/Read .* before overwriting/);
    expect(await manager.readFile(sandboxId, APP)).toEqual({
      ok: true,
      value: "const a = 2;\nprecious\n",
    });
  });

  it("refuses to overwrite a file this turn has not read", async () => {
    await manager.writeFile(sandboxId, APP, "precious\n");

    const result = await run("write_file", { path: APP, contents: "replaced\n" });

    expect(result.ok).toBe(false);
    expect(await manager.readFile(sandboxId, APP)).toEqual({ ok: true, value: "precious\n" });
  });

  it("lets the edit through once the file has been read", async () => {
    await manager.writeFile(sandboxId, APP, "const a = 1;\n");
    await run("read_file", { path: APP });

    const result = await run("edit_file", { path: APP, old_string: "1", new_string: "2" });

    expect(result.ok).toBe(true);
  });

  it("counts a path read in another spelling as the same file", () => {
    // Asked of the ledger directly: the in-memory sandbox stores paths verbatim, where a real
    // filesystem would resolve this one.
    ledger.remember(`${PROJECT_ROOT}/src/../src/App.tsx`);
    expect(ledger.knows(APP)).toBe(true);
    ledger.forget(`${PROJECT_ROOT}//src/App.tsx`);
    expect(ledger.knows(APP)).toBe(false);
  });

  it("needs no read to create a file, and knows a file it wrote", async () => {
    const created = await run("write_file", { path: APP, contents: "a\n" });
    const edited = await run("edit_file", { path: APP, old_string: "a", new_string: "b" });
    expect([created.ok, edited.ok]).toEqual([true, true]);
  });
});

describe("edit_file", () => {
  beforeEach(async () => {
    await manager.writeFile(sandboxId, APP, "old and old and old\n");
    await run("read_file", { path: APP });
  });

  it("refuses an ambiguous edit and offers replace_all", async () => {
    const result = await run("edit_file", { path: APP, old_string: "old", new_string: "new" });
    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/appears 3 times.*replace_all/);
  });

  it("replaces every occurrence when told to", async () => {
    const result = await run("edit_file", {
      path: APP,
      old_string: "old",
      new_string: "new",
      replace_all: true,
    });
    expect(result.output).toBe(`Edited ${APP}: replaced 3 occurrences.`);
    expect(await manager.readFile(sandboxId, APP)).toEqual({
      ok: true,
      value: "new and new and new\n",
    });
  });

  it("writes replacement text exactly, even where it looks like a replacement pattern", async () => {
    await manager.writeFile(sandboxId, APP, "price\n");
    const result = await run("edit_file", {
      path: APP,
      old_string: "price",
      new_string: "$& $1 $$",
    });
    expect(result.ok).toBe(true);
    expect(await manager.readFile(sandboxId, APP)).toEqual({ ok: true, value: "$& $1 $$\n" });
  });
});
