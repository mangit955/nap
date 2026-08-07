/**
 * The contract every `SandboxManager` must satisfy, as an executable suite.
 *
 * There are two implementations of the interface — an in-memory fake used by every
 * downstream package's tests, and the real E2B adapter — and the fake is only useful
 * if it behaves like the real one. So the behaviour lives here once and both run it:
 * the fake from a unit test, E2B from an integration test. A divergence shows up as a
 * failing conformance case rather than as a mystery in whatever code trusted the fake.
 *
 * This file is deliberately not named `*.test.ts`. It defines tests but does not
 * contain any, so no Vitest project should collect it on its own.
 *
 * Implementations differ in two ways the contract cannot paper over — where they let
 * you write, and what shell they run — so a caller supplies those as a harness.
 */

import type { SandboxManager } from "@nap/shared/ports/sandbox-manager";
import { describe, expect, it } from "vitest";

export type SandboxManagerHarness = {
  /** Names the implementation in test output, e.g. "InMemorySandboxManager". */
  name: string;

  /**
   * A manager plus whatever it takes to tear it down. Called per test, so no case
   * can leak state into the next — which matters most for the real adapter, where
   * a leaked sandbox costs money.
   */
  createManager(): Promise<{ manager: SandboxManager; cleanup(): Promise<void> }>;

  /** Absolute directory the suite may write under: `/` here, a home directory there. */
  root: string;

  /**
   * An id that is *well-formed* for this implementation but belongs to no sandbox.
   *
   * The suite cannot invent one: a real provider validates the shape of an id before
   * looking it up, so an arbitrary string comes back as "malformed request" rather than
   * "no such sandbox" — a different failure, and not the one these cases are about.
   */
  unknownSandboxId(): string;

  /**
   * Concrete commands, because the suite asserts on output and exit codes and cannot
   * assume a shell. Each implementation supplies invocations meeting these contracts.
   */
  commands: {
    /** Writes "one\n" to stdout, then "two\n" to stderr, then exits 0. */
    streamsOutput: string;
    /** Exits 3. Output is not asserted on. */
    failsWithCode3: string;
  };
};

/** A distinct directory per test, so a shared real sandbox cannot collide with itself. */
function uniqueDir(root: string): string {
  return `${root.replace(/\/$/, "")}/conformance-${crypto.randomUUID()}`;
}

export function describeSandboxManagerConformance(harness: SandboxManagerHarness): void {
  describe(`SandboxManager conformance: ${harness.name}`, () => {
    /**
     * Runs `body` against a fresh manager and one sandbox, then tears down. Returning
     * the promise from each `it` is what makes the cleanup ordering reliable.
     */
    async function withSandbox(
      body: (ctx: { manager: SandboxManager; sandboxId: string; dir: string }) => Promise<void>,
    ): Promise<void> {
      const { manager, cleanup } = await harness.createManager();
      try {
        const created = await manager.create("project-under-test");
        if (!created.ok) {
          throw new Error(`harness could not create a sandbox: ${created.error.message}`);
        }
        await body({
          manager,
          sandboxId: created.value.id,
          dir: uniqueDir(harness.root),
        });
      } finally {
        await cleanup();
      }
    }

    it("reads back what it wrote", async () => {
      await withSandbox(async ({ manager, sandboxId, dir }) => {
        const written = await manager.writeFile(sandboxId, `${dir}/hello.txt`, "hello world");
        expect(written.ok).toBe(true);

        const read = await manager.readFile(sandboxId, `${dir}/hello.txt`);
        expect(read).toEqual({ ok: true, value: "hello world" });
      });
    });

    it("overwrites an existing file rather than appending", async () => {
      await withSandbox(async ({ manager, sandboxId, dir }) => {
        await manager.writeFile(sandboxId, `${dir}/hello.txt`, "first");
        await manager.writeFile(sandboxId, `${dir}/hello.txt`, "second");

        const read = await manager.readFile(sandboxId, `${dir}/hello.txt`);
        expect(read).toEqual({ ok: true, value: "second" });
      });
    });

    it("reports a missing file as a typed error instead of throwing", async () => {
      await withSandbox(async ({ manager, sandboxId, dir }) => {
        // The distinction the Result type exists for: an agent asking for a file that
        // is not there is an ordinary turn, not a crash.
        const read = await manager.readFile(sandboxId, `${dir}/nope.txt`);

        expect(read.ok).toBe(false);
        if (read.ok) return;
        expect(read.error.code).toBe("file_not_found");
      });
    });

    it("lists the direct children of a directory, one level at a time", async () => {
      await withSandbox(async ({ manager, sandboxId, dir }) => {
        await manager.writeFile(sandboxId, `${dir}/top.txt`, "top");
        await manager.writeFile(sandboxId, `${dir}/nested/inner.txt`, "inner");
        await manager.writeFile(sandboxId, `${dir}/nested/deeper/deepest.txt`, "deepest");

        const top = await manager.listFiles(sandboxId, dir);
        expect(top.ok).toBe(true);
        if (!top.ok) return;
        // Sorted, because neither a real filesystem nor a Map promises an order.
        expect([...top.value].sort((a, b) => a.path.localeCompare(b.path))).toEqual([
          { path: `${dir}/nested`, type: "directory" },
          { path: `${dir}/top.txt`, type: "file" },
        ]);

        // The second level is what proves this is not a flattened recursive walk:
        // `deeper` appears as a directory here and its contents do not.
        const nested = await manager.listFiles(sandboxId, `${dir}/nested`);
        expect(nested.ok).toBe(true);
        if (!nested.ok) return;
        expect([...nested.value].sort((a, b) => a.path.localeCompare(b.path))).toEqual([
          { path: `${dir}/nested/deeper`, type: "directory" },
          { path: `${dir}/nested/inner.txt`, type: "file" },
        ]);
      });
    });

    it("streams exec output in order, then resolves with the exit code", async () => {
      await withSandbox(async ({ manager, sandboxId }) => {
        const chunks: Array<{ stream: string; data: string }> = [];

        const result = await manager.exec(sandboxId, harness.commands.streamsOutput, (chunk) => {
          chunks.push(chunk);
        });

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.exitCode).toBe(0);
        expect(result.value.stdout).toContain("one");
        expect(result.value.stderr).toContain("two");

        // Streaming is the point: the handler must have seen the output before the
        // promise resolved.
        //
        // Asserted per stream rather than chunk by chunk, because how a real
        // implementation splits and schedules a stream is its own business. A process
        // writing one line may deliver it as one callback or several, and stdout and
        // stderr travel independently — so their *relative* arrival order is not
        // something an implementation can promise, and asserting it produced a test
        // that failed roughly one run in three against real E2B. Order within a single
        // stream is guaranteed, and that is what is checked here.
        const joined = (stream: string) =>
          chunks
            .filter((c) => c.stream === stream)
            .map((c) => c.data)
            .join("");

        expect(chunks.length).toBeGreaterThan(0);
        expect(joined("stdout").trim()).toBe("one");
        expect(joined("stderr").trim()).toBe("two");
      });
    });

    it("reports a non-zero exit as data, not as an error", async () => {
      await withSandbox(async ({ manager, sandboxId }) => {
        const result = await manager.exec(sandboxId, harness.commands.failsWithCode3);

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.exitCode).toBe(3);
      });
    });

    it("accepts exec without an output handler", async () => {
      await withSandbox(async ({ manager, sandboxId }) => {
        const result = await manager.exec(sandboxId, harness.commands.streamsOutput);
        expect(result.ok).toBe(true);
      });
    });

    it("returns an https preview URL carrying the port", async () => {
      await withSandbox(async ({ manager, sandboxId }) => {
        const result = await manager.getPreviewUrl(sandboxId, 5173);

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const url = new URL(result.value);
        expect(url.protocol).toBe("https:");
        expect(url.hostname).toContain("5173");
      });
    });

    it("resumes a sandbox it created", async () => {
      await withSandbox(async ({ manager, sandboxId }) => {
        const resumed = await manager.resume(sandboxId);

        expect(resumed.ok).toBe(true);
        if (!resumed.ok) return;
        expect(resumed.value.id).toBe(sandboxId);
      });
    });

    it("reports an unknown sandbox id as not_found", async () => {
      await withSandbox(async ({ manager }) => {
        const resumed = await manager.resume(harness.unknownSandboxId());

        expect(resumed.ok).toBe(false);
        if (resumed.ok) return;
        expect(resumed.error.code).toBe("not_found");
      });
    });

    it("fails every operation with `destroyed` once the sandbox is destroyed", async () => {
      await withSandbox(async ({ manager, sandboxId, dir }) => {
        await manager.writeFile(sandboxId, `${dir}/before.txt`, "before");

        const destroyed = await manager.destroy(sandboxId);
        expect(destroyed.ok).toBe(true);

        // `destroyed` rather than `not_found`, because the caller's mistake is using a
        // sandbox it already tore down — a different bug from using an id that never
        // existed, and worth telling apart in a log.
        const results = [
          await manager.readFile(sandboxId, `${dir}/before.txt`),
          await manager.writeFile(sandboxId, `${dir}/after.txt`, "after"),
          await manager.listFiles(sandboxId, dir),
          await manager.exec(sandboxId, harness.commands.streamsOutput),
          await manager.getPreviewUrl(sandboxId, 5173),
          await manager.resume(sandboxId),
        ];

        for (const result of results) {
          expect(result.ok).toBe(false);
          if (result.ok) continue;
          expect(result.error.code).toBe("destroyed");
        }
      });
    });

    it("reports destroying an unknown sandbox as not_found", async () => {
      await withSandbox(async ({ manager }) => {
        const result = await manager.destroy(harness.unknownSandboxId());

        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.code).toBe("not_found");
      });
    });

    it("isolates the filesystems of two sandboxes", async () => {
      await withSandbox(async ({ manager, sandboxId, dir }) => {
        const other = await manager.create("another-project");
        expect(other.ok).toBe(true);
        if (!other.ok) return;

        await manager.writeFile(sandboxId, `${dir}/only-here.txt`, "mine");

        const read = await manager.readFile(other.value.id, `${dir}/only-here.txt`);
        expect(read.ok).toBe(false);
        if (read.ok) return;
        expect(read.error.code).toBe("file_not_found");

        await manager.destroy(other.value.id);
      });
    });
  });
}
