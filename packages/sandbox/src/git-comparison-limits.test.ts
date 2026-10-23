import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import { GitComparisonSchema } from "@nap/shared/git-protocol";
import { describe, expect, it } from "vitest";
import { COMPARISON_SCRIPT } from "./git-comparison.ts";

// Execute the shipped script, replacing only its subprocess and clock boundaries.
// No real Git processes, elapsed waits, or large repository fixtures are needed here.
function scriptFixture({
  commandMs = 0,
  overflow = false,
}: {
  commandMs?: number;
  overflow?: boolean;
} = {}) {
  let now = 0;
  let stdout = "";
  const calls: { args: string[]; timeout: number; startedAt: number }[] = [];
  const patches: string[] = [];
  const patch = "@@ -1 +1,25000 @@\n-old\n" + "+new\n".repeat(25_000);
  const childProcess = {
    execFileSync(_command: string, args: string[], options: { timeout: number }) {
      calls.push({ args, timeout: options.timeout, startedAt: now });
      now += commandMs;
      if (args.includes("rev-parse")) return args.includes("HEAD^") ? "base\n" : "head\n";
      if (args.includes("symbolic-ref")) return "main\n";
      if (args.includes("--name-status"))
        return Array.from({ length: 7 }, (_, index) => `M\0file-${index}.ts\0`).join("");
      if (args.includes("diff")) {
        const path = args.at(-1) ?? "";
        patches.push(path);
        if (overflow)
          throw Object.assign(new Error("output buffer exceeded"), {
            code: "ENOBUFS",
            stdout: "@@ -1 +1,25000 @@\n-old\n+only the beginning\n",
          });
        return patch;
      }
      throw new Error(`Unexpected Git arguments: ${JSON.stringify(args)}`);
    },
  };
  class Clock extends Date {
    static override now() {
      return now;
    }
  }
  const performance = { now: () => now };
  return {
    calls,
    patches,
    run: () =>
      runInNewContext(
        COMPARISON_SCRIPT,
        {
          require: (name: string) => {
            if (name === "node:child_process") return childProcess;
            if (name === "node:crypto") return { createHash };
            if (name === "node:perf_hooks") return { performance };
            throw new Error(`Unexpected script dependency: ${name}`);
          },
          Buffer,
          Date: Clock,
          performance,
          process: {
            argv: ["node", "commit", ""],
            stdout: {
              write: (text: string) => {
                stdout += text;
              },
            },
          },
        },
        { timeout: 1000 },
      ),
    result: () => GitComparisonSchema.parse(JSON.parse(stdout)),
  };
}

describe("Git comparison execution limits", () => {
  it("shares a twenty-second deadline across Git commands instead of renewing each timeout", () => {
    const fixture = scriptFixture({ commandMs: 6000 });
    expect(() => fixture.run()).toThrow(/deadline|timed out|time limit/i);
    expect(fixture.calls.length).toBeGreaterThan(1);
    expect(fixture.calls.every((call) => call.startedAt < 20_000)).toBe(true);
    for (const call of fixture.calls) {
      expect(call.timeout).toBeGreaterThan(0);
      expect(call.timeout).toBeLessThanOrEqual(20_000 - call.startedAt);
    }
  });
  it("stops patch work at the display budget and omits uncomputed rows instead of inventing zero counts", () => {
    const fixture = scriptFixture();
    fixture.run();
    const result = fixture.result();
    expect(fixture.patches).toEqual(["file-0.ts", "file-1.ts", "file-2.ts", "file-3.ts"]);
    expect(result.truncated).toBe(true);
    expect(result.files.map((file) => file.path)).toEqual(fixture.patches);
    expect(result.files.every((file) => file.additions === 25_000 && file.deletions === 1)).toBe(
      true,
    );
    expect(
      result.files.reduce((bytes, file) => bytes + Buffer.byteLength(file.patch), 0),
    ).toBeLessThanOrEqual(384 * 1024);
    expect(result.files.every((file) => Buffer.byteLength(file.patch) <= 120 * 1024)).toBe(true);
  });
  it("refuses incomplete subprocess output rather than publishing its partial counts as exact", () => {
    const fixture = scriptFixture({ overflow: true });
    expect(() => fixture.run()).toThrow(/buffer|output|large|limit/i);
    expect(fixture.patches).toHaveLength(1);
  });
});
