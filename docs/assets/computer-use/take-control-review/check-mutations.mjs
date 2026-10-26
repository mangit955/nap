import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";

const hook = "apps/web/src/computer/use-computer-control.ts";
const input = "apps/web/src/computer/computer-input-surface.tsx";
const mutations = [
  {
    file: hook,
    name: "late grant generation",
    from: "alive && version === generation",
    to: "alive",
    test: "a project lease during a pending grant",
  },
  {
    file: hook,
    name: "serialized dispatch",
    from: "if (inflight || !alive) return;",
    to: "if (!alive) return;",
    test: "serializes requests",
  },
  {
    file: hook,
    name: "partial applied count",
    from: "!parsed.success || parsed.data.applied !== item.actions.length",
    to: "!parsed.success",
    test: "never replays ambiguous",
  },
  {
    file: hook,
    name: "poll cleanup",
    from: "clearTimeout(pollTimer);",
    to: "void pollTimer;",
    test: "release, expiry and unmount",
  },
  {
    file: input,
    name: "double click after flushed or acquisition click",
    from: 'action: pending ? "double_click" : "left_click"',
    to: 'action: "double_click"',
    test: "remaining click",
  },
  {
    file: input,
    name: "paste request deadline isolation",
    from: "for (const action of actions) void sendActions([action]);",
    to: "void sendActions(actions);",
    test: "maximum paste",
  },
  {
    file: input,
    name: "paste enqueue before later input",
    from: "for (const action of actions) void sendActions([action]);",
    to: "void (async () => { for (const action of actions) await sendActions([action]); })();",
    test: "maximum paste",
  },
  {
    file: input,
    name: "letterbox mapping",
    from: "(bounds.width - DESKTOP_WIDTH * scale) / 2",
    to: "0",
    test: "ignores letterbox and maps",
  },
  {
    file: input,
    name: "IME duplicate suppression",
    from: "if (echo.current === value)",
    to: "if (false)",
    test: "ordinary text, touch input and IME",
  },
  {
    file: input,
    name: "pending click cleanup",
    from: "const cancel = () => {\n    if (click.current) clearTimeout(click.current.timer);",
    to: "const cancel = () => {\n    if (click.current) void click.current.timer;",
    test: "retires composition",
  },
];
for (const mutation of mutations) {
  const original = await readFile(mutation.file, "utf8");
  assert.equal(original.split(mutation.from).length, 2, `Unique mutation site: ${mutation.name}`);
  try {
    await writeFile(mutation.file, original.replace(mutation.from, mutation.to));
    const suite = mutation.file.replace(/\.tsx?$/, ".test.tsx");
    const result = spawnSync(
      "bun",
      ["x", "vitest", "run", "--project", "web", "--maxWorkers=2", suite, "-t", mutation.test],
      { encoding: "utf8", timeout: 60_000 },
    );
    assert.equal(result.error, undefined, `${mutation.name}: runner error`);
    assert.notEqual(result.status, 0, `${mutation.name}: mutation survived`);
    assert.match(
      result.stdout + result.stderr,
      /AssertionError/,
      `${mutation.name}: must fail on a behavior assertion`,
    );
    console.log(`CAUGHT: ${mutation.name}`);
  } finally {
    await writeFile(mutation.file, original);
  }
}
console.log(
  `PASS: ${mutations.length} mutations caught; source restored. Rerun focused tests after this script.`,
);
