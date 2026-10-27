import { InMemorySandboxManager } from "@nap/sandbox/testing/in-memory-sandbox-manager";
import type { PendingEvent } from "@nap/shared/ports/event-store";
import { beforeEach, describe, expect, it } from "vitest";
import type { ToolContext } from "./context.ts";
import { PROJECT_ROOT } from "./definitions.ts";
import { executeTool } from "./execute.ts";
import { FileLedger } from "./ledger.ts";
import { applyHunks, type Hunk, parsePatch } from "./patch.ts";

const APP = `${PROJECT_ROOT}/src/App.tsx`;

function hunk(partial: Partial<Hunk>): Hunk {
  return { anchor: null, before: [], after: [], atEnd: false, ...partial };
}

describe("parsePatch", () => {
  it("reads every kind of section", () => {
    const parsed = parsePatch(
      [
        "*** Begin Patch",
        "*** Add File: src/new.ts",
        "+export const a = 1;",
        "+",
        "*** Update File: src/App.tsx",
        "*** Move to: src/Main.tsx",
        "@@ function App() {",
        " const a = 1;",
        "-const b = 2;",
        "+const b = 3;",
        "*** End of File",
        "*** Delete File: src/old.ts",
        "*** End Patch",
      ].join("\n"),
    );
    expect(parsed).toEqual({
      ok: true,
      value: [
        { kind: "add", path: "src/new.ts", contents: "export const a = 1;\n\n" },
        {
          kind: "update",
          path: "src/App.tsx",
          moveTo: "src/Main.tsx",
          hunks: [
            {
              anchor: "function App() {",
              before: ["const a = 1;", "const b = 2;"],
              after: ["const a = 1;", "const b = 3;"],
              atEnd: true,
            },
          ],
        },
        { kind: "delete", path: "src/old.ts" },
      ],
    });
  });

  it("accepts a first hunk with no @@ line and a context line that lost its space", () => {
    const parsed = parsePatch(
      "*** Begin Patch\n*** Update File: a.ts\n x\n\n-y\n+z\n*** End Patch",
    );
    expect(parsed.ok && parsed.value[0]).toEqual({
      kind: "update",
      path: "a.ts",
      moveTo: null,
      hunks: [hunk({ before: ["x", "", "y"], after: ["x", "", "z"] })],
    });
  });

  it("finds the patch inside a fence or a heredoc", () => {
    const parsed = parsePatch(
      "```\napply_patch <<'EOF'\n*** Begin Patch\n*** Delete File: a.ts\n*** End Patch\nEOF\n```",
    );
    expect(parsed).toEqual({ ok: true, value: [{ kind: "delete", path: "a.ts" }] });
  });

  it.each([
    ["no begin marker", "*** Update File: a.ts\n+x\n*** End Patch", /must start/],
    ["no end marker", "*** Begin Patch\n*** Delete File: a.ts", /must end/],
    [
      "an added line without +",
      "*** Begin Patch\n*** Add File: a.ts\nx\n*** End Patch",
      /starts with "\+"/,
    ],
    [
      "an update with nothing in it",
      "*** Begin Patch\n*** Update File: a.ts\n*** End Patch",
      /no changes/,
    ],
    ["a stray line", "*** Begin Patch\nhello\n*** End Patch", /Expected a file header/],
    ["no sections", "*** Begin Patch\n*** End Patch", /changes no files/],
    [
      "a bad hunk marker",
      "*** Begin Patch\n*** Update File: a.ts\n@@\n*x\n*** End Patch",
      /start with/,
    ],
  ])("refuses %s", (_name, text, message) => {
    const parsed = parsePatch(text);
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? "" : parsed.error).toMatch(message);
  });
});

describe("applyHunks", () => {
  const SOURCE = "function a() {\n  return 1;\n}\n\nfunction b() {\n  return 1;\n}\n";

  it("places a hunk by its context alone", () => {
    expect(
      applyHunks(SOURCE, [
        hunk({
          before: ["function b() {", "  return 1;"],
          after: ["function b() {", "  return 2;"],
        }),
      ]),
    ).toEqual({ ok: true, value: SOURCE.replace("b() {\n  return 1", "b() {\n  return 2") });
  });

  it("uses the anchor to choose between identical stretches", () => {
    const applied = applyHunks(SOURCE, [
      hunk({ anchor: "function b() {", before: ["  return 1;"], after: ["  return 2;"] }),
    ]);
    expect(applied).toEqual({
      ok: true,
      value: SOURCE.replace("b() {\n  return 1", "b() {\n  return 2"),
    });
  });

  it("applies hunks in order, each after the last", () => {
    const applied = applyHunks(SOURCE, [
      hunk({ before: ["  return 1;"], after: ["  return 10;"] }),
      hunk({ before: ["  return 1;"], after: ["  return 20;"] }),
    ]);
    expect(applied.ok && applied.value).toContain("return 10;\n}\n\nfunction b() {\n  return 20;");
  });

  it("forgives trailing whitespace and then indentation, but nothing looser", () => {
    expect(
      applyHunks("  x = 1;   \n", [hunk({ before: ["  x = 1;"], after: ["  x = 2;"] })]),
    ).toEqual({
      ok: true,
      value: "  x = 2;\n",
    });
    expect(applyHunks("\tx = 1;\n", [hunk({ before: ["x = 1;"], after: ["x = 2;"] })])).toEqual({
      ok: true,
      value: "x = 2;\n",
    });
    expect(applyHunks("x=1;\n", [hunk({ before: ["x = 1;"], after: ["x = 2;"] })]).ok).toBe(false);
  });

  it("holds an end-of-file hunk to the file's last lines", () => {
    const text = "a\nb\na\nb\n";
    expect(
      applyHunks(text, [hunk({ before: ["a", "b"], after: ["a", "c"], atEnd: true })]),
    ).toEqual({ ok: true, value: "a\nb\na\nc\n" });
  });

  it("appends a pure insertion with no anchor, and inserts one after its anchor", () => {
    expect(applyHunks("a\n", [hunk({ after: ["b"] })])).toEqual({ ok: true, value: "a\nb\n" });
    expect(applyHunks("a\nc\n", [hunk({ anchor: "a", after: ["b"] })])).toEqual({
      ok: true,
      value: "a\nb\nc\n",
    });
  });

  it("keeps a file without a final newline that way", () => {
    expect(applyHunks("a\nb", [hunk({ before: ["b"], after: ["c"] })])).toEqual({
      ok: true,
      value: "a\nc",
    });
  });

  it("says which hunk failed and what it expected", () => {
    const applied = applyHunks(SOURCE, [
      hunk({ before: ["  return 1;"], after: ["  return 3;"] }),
      hunk({ before: ["  return 9;"], after: ["  return 3;"] }),
    ]);
    expect(applied).toEqual({
      ok: false,
      error: "Hunk 2: these lines are not in the file:\n  return 9;",
    });
  });
});

describe("apply_patch", () => {
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
    manager.script(/^rm -f -- /, {});
    await manager.writeFile(sandboxId, APP, "export function App() {\n  return null;\n}\n");
    await manager.writeFile(sandboxId, `${PROJECT_ROOT}/src/old.ts`, "old\n");
  });

  function patch(...lines: string[]) {
    const ctx: ToolContext = {
      sessionId: "2a3f8a24-6c1b-4e0e-9b6f-3a5c0a1d9e77",
      turnId: "7c9b1a52-8d3e-4f21-a0c4-1b2d3e4f5a6b",
      sandboxId,
      sandbox: manager,
      ledger,
      emit: (event) => events.push(event as PendingEvent),
    };
    return executeTool(
      {
        id: "toolu_patch",
        name: "apply_patch",
        input: { patch: ["*** Begin Patch", ...lines, "*** End Patch"].join("\n") },
      },
      ctx,
    );
  }

  it("adds, updates and deletes, reporting each change to the log", async () => {
    const result = await patch(
      "*** Add File: src/Hello.tsx",
      "+export const Hello = () => <p>hi</p>;",
      `*** Update File: ${APP}`,
      "@@",
      "-  return null;",
      "+  return <Hello />;",
      "*** Delete File: src/old.ts",
    );

    expect(result).toEqual({
      ok: true,
      output: `Added ${PROJECT_ROOT}/src/Hello.tsx\nUpdated ${APP}\nDeleted ${PROJECT_ROOT}/src/old.ts`,
    });
    expect(await manager.readFile(sandboxId, APP)).toEqual({
      ok: true,
      value: "export function App() {\n  return <Hello />;\n}\n",
    });
    expect(manager.commands(sandboxId)).toEqual([`rm -f -- '${PROJECT_ROOT}/src/old.ts'`]);
    expect(
      events
        .filter((event) => event.type === "file.changed")
        .map(
          (event) =>
            event.type === "file.changed" && [event.payload.path, event.payload.changeType],
        ),
    ).toEqual([
      [`${PROJECT_ROOT}/src/Hello.tsx`, "created"],
      [APP, "modified"],
      [`${PROJECT_ROOT}/src/old.ts`, "deleted"],
    ]);
    // What a patch wrote is known to the turn; what it deleted is not.
    expect(ledger.knows(APP)).toBe(true);
    expect(ledger.knows(`${PROJECT_ROOT}/src/old.ts`)).toBe(false);
  });

  it("moves a file, writing the new path and removing the old", async () => {
    const result = await patch(
      `*** Update File: ${APP}`,
      "*** Move to: src/Main.tsx",
      "@@",
      "-  return null;",
      "+  return 1;",
    );
    expect(result.ok).toBe(true);
    expect((await manager.readFile(sandboxId, `${PROJECT_ROOT}/src/Main.tsx`)).ok).toBe(true);
    expect(manager.commands(sandboxId)).toEqual([`rm -f -- '${APP}'`]);
  });

  it("changes nothing at all when any one section cannot be applied", async () => {
    const result = await patch(
      "*** Add File: src/Hello.tsx",
      "+hi",
      `*** Update File: ${APP}`,
      "-  return undefined;",
      "+  return 1;",
    );

    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/Nothing was changed/);
    expect((await manager.readFile(sandboxId, `${PROJECT_ROOT}/src/Hello.tsx`)).ok).toBe(false);
    expect(events.filter((event) => event.type === "file.changed")).toEqual([]);
  });

  it.each([
    ["*** Add File: src/Main.tsx", "+new", `*** Update File: ${APP}`, "*** Move to: src/Main.tsx"],
    [`*** Update File: ${APP}`, "*** Move to: src/Main.tsx", "*** Add File: src/Main.tsx", "+new"],
    [
      `*** Update File: ${APP}`,
      "*** Move to: src/Main.tsx",
      "*** Update File: src/old.ts",
      "*** Move to: src/Main.tsx",
    ],
  ])("refuses colliding move destinations before writing", async (...lines) => {
    const before = await manager.readFile(sandboxId, APP);
    const result = await patch(...lines);

    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/more than one section/);
    expect(await manager.readFile(sandboxId, APP)).toEqual(before);
    expect((await manager.readFile(sandboxId, `${PROJECT_ROOT}/src/Main.tsx`)).ok).toBe(false);
    expect(events.filter((event) => event.type === "file.changed")).toEqual([]);
  });

  it("reports a failed deletion without forgetting or reporting the file as deleted", async () => {
    ledger.remember(APP);
    const exec = manager.exec.bind(manager);
    manager.exec = (id, command, onOutput, options) =>
      command.startsWith("rm -f")
        ? Promise.resolve({
            ok: true,
            value: { exitCode: 1, stdout: "", stderr: "Permission denied" },
          })
        : exec(id, command, onOutput, options);

    const result = await patch(`*** Delete File: ${APP}`);

    expect(result.ok).toBe(false);
    expect(result.output).toContain("Permission denied");
    expect(ledger.knows(APP)).toBe(true);
    expect((await manager.readFile(sandboxId, APP)).ok).toBe(true);
    expect(events.filter((event) => event.type === "file.changed")).toEqual([]);
  });

  it.each([
    ["adding a file that exists", ["*** Add File: src/old.ts", "+x"], /already exists/],
    [
      "updating a file that does not",
      ["*** Update File: src/nope.ts", "-a", "+b"],
      /does not exist/,
    ],
    ["deleting a file that does not", ["*** Delete File: src/nope.ts"], /does not exist/],
    [
      "moving onto a file that exists",
      [`*** Update File: ${APP}`, "*** Move to: src/old.ts", "-  return null;", "+  return 1;"],
      /already exists/,
    ],
    [
      "two sections for one file",
      ["*** Delete File: src/old.ts", "*** Delete File: src/old.ts"],
      /more than one section/,
    ],
  ])("refuses %s", async (_name, lines, message) => {
    const result = await patch(...lines);
    expect(result.ok).toBe(false);
    expect(result.output).toMatch(message);
    expect(manager.commands(sandboxId)).toEqual([]);
  });
});
