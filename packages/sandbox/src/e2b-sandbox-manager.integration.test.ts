/**
 * The conformance suite, run against real E2B.
 *
 * This is the whole point of having written the contract as a reusable suite: the fake
 * that every other package's tests depend on is only trustworthy if the same assertions
 * hold against the real thing. Everything here costs money and needs the network, which
 * is why it lives in `test:integration` and never runs in CI.
 *
 * Each case creates its own sandbox and kills it in teardown. The final check asserts
 * that none survived — an orphaned sandbox bills until it times out.
 */

import { Sandbox } from "e2b";
import { afterAll, expect, it, vi } from "vitest";
import { E2BSandboxManager } from "./e2b-sandbox-manager.ts";
import { describeSandboxManagerConformance } from "./testing/conformance.ts";

if (process.env.E2B_API_KEY === undefined || process.env.E2B_API_KEY === "") {
  // Thrown, not skipped: a suite that quietly passes with nothing behind it is worse
  // than one that fails, because it reports the contract as verified when it is not.
  throw new Error(
    "E2B_API_KEY is not set, so the E2B conformance run cannot verify anything. " +
      "Put it in apps/api/.env or export it, then re-run `bun run test:integration`.",
  );
}

/** Every sandbox this file created, so teardown can prove it left nothing behind. */
const created = new Set<string>();

describeSandboxManagerConformance({
  name: "E2BSandboxManager",
  // The default E2B template's user home. Writing outside it needs root.
  root: "/home/user",
  commands: {
    streamsOutput: "printf 'one\\n'; printf 'two\\n' >&2",
    failsWithCode3: "exit 3",
  },
  // E2B validates the *shape* of an id before looking it up: an arbitrary string comes
  // back as "400: Invalid sandbox ID", which is a caller bug rather than a missing
  // sandbox. This matches the real format — 20 lowercase alphanumerics — so the request
  // reaches the lookup and genuinely 404s.
  unknownSandboxId: () =>
    `i${Array.from({ length: 19 }, () => "abcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(Math.random() * 36)]).join("")}`,
  createManager: async () => {
    const manager = new E2BSandboxManager();
    const sandboxIds: string[] = [];

    return {
      // Delegation rather than a Proxy: the adapter keeps its state in `#private`
      // fields, and those throw through a Proxy because the receiver is the proxy
      // rather than the instance. Spelling the methods out costs a few lines and
      // cannot break that way.
      manager: {
        create: async (projectId) => {
          const result = await manager.create(projectId);
          if (result.ok) {
            sandboxIds.push(result.value.id);
            created.add(result.value.id);
          }
          return result;
        },
        resume: (id) => manager.resume(id),
        destroy: (id) => manager.destroy(id),
        extendTimeout: (id, ms) => manager.extendTimeout(id, ms),
        writeFile: (id, path, contents) => manager.writeFile(id, path, contents),
        readFile: (id, path) => manager.readFile(id, path),
        listFiles: (id, path) => manager.listFiles(id, path),
        exec: (id, command, onOutput, options) => manager.exec(id, command, onOutput, options),
        getPreviewUrl: (id, port) => manager.getPreviewUrl(id, port),
        waitForPreview: (id, port, opts) => manager.waitForPreview(id, port, opts),
      },
      cleanup: async () => {
        // Kill directly rather than through the manager: a case that already called
        // destroy() would otherwise get `destroyed` back and leave the sandbox alive.
        await Promise.all(sandboxIds.map((id) => Sandbox.kill(id).catch(() => false)));
      },
    };
  },
});

it("stops a command and what it started when its signal fires", async () => {
  // Real E2B only, because this is a fact about envd rather than about our code: the SDK documents
  // that the kill sends SIGKILL to the command, and says nothing about the command's children.
  const manager = new E2BSandboxManager();
  const opened = await manager.create("stop-on-abort");
  if (!opened.ok) throw new Error(opened.error.message);
  const sandboxId = opened.value.id;
  created.add(sandboxId);
  try {
    const controller = new AbortController();
    const running = manager.exec(
      sandboxId,
      "sh -c 'echo $$ > /tmp/child.pid; sleep 300; true' & wait",
      undefined,
      { signal: controller.signal, stopOnAbort: true, timeoutMs: 120_000 },
    );
    await vi.waitFor(
      async () => expect((await manager.readFile(sandboxId, "/tmp/child.pid")).ok).toBe(true),
      { timeout: 15_000, interval: 500 },
    );

    controller.abort();
    await running;

    await vi.waitFor(
      async () => {
        const alive = await manager.exec(sandboxId, "kill -0 $(cat /tmp/child.pid)");
        expect(alive).toMatchObject({ ok: true });
        expect(alive.ok && alive.value.exitCode).not.toBe(0);
      },
      { timeout: 15_000, interval: 1_000 },
    );
  } finally {
    await Sandbox.kill(sandboxId).catch(() => false);
  }
}, 60_000);

afterAll(async () => {
  const stillRunning: string[] = [];

  for (const id of created) {
    try {
      const info = await Sandbox.getInfo(id);
      if (info.state === "running") stillRunning.push(id);
    } catch {
      // Not found is the outcome we want: the sandbox is gone.
    }
  }

  expect(stillRunning, `orphaned E2B sandboxes left running: ${stillRunning.join(", ")}`).toEqual(
    [],
  );
}, 60_000);
