/**
 * The fakes, slowed down to the speed of the real thing.
 *
 * Wrappers rather than new fakes: the in-memory sandbox and the scripted provider are already
 * production-quality and already held to their ports' contracts, and a second implementation
 * whose only difference is that it sleeps would drift from them. Everything here delegates and
 * answers exactly what it was given — the only thing added is time.
 *
 * Which calls get slowed is a claim about where a real turn's seconds go, and only three places
 * in `docs/napbench-first-real-run.md` recorded any: the cold start, the preview render, and the
 * turn itself. Nothing else is slowed, because nothing else was measured.
 */

import type { LLMProvider, LLMRequest, LLMTurn } from "@nap/shared/ports/llm-provider";
import type { SandboxManager } from "@nap/shared/ports/sandbox-manager";
import { CALIBRATION, sampleRange } from "./calibration.ts";

/** How to wait. Injected so a test can assert on the durations without spending them. */
export type Sleep = (ms: number) => Promise<void>;

export type SlowOptions = {
  sleep?: Sleep;
  /** The draw behind each turn's duration. Seed it from `seededRandom` for a repeatable run. */
  random?: () => number;
};

const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function slowSandboxManager(inner: SandboxManager, options: SlowOptions = {}) {
  const sleep = options.sleep ?? realSleep;

  const slowed: SandboxManager = {
    create: async (projectId) => {
      // Before, not after: the wait is the container coming up, and everything queued behind
      // this call is queued behind that.
      await sleep(CALIBRATION.sandboxCreateMs);
      return await inner.create(projectId);
    },
    // A resume is a sandbox that already exists being reattached to, which the recorded run
    // never timed separately — so it is left alone rather than given an invented figure.
    resume: (sandboxId) => inner.resume(sandboxId),
    destroy: (sandboxId) => inner.destroy(sandboxId),
    extendTimeout: (sandboxId, ms) => inner.extendTimeout(sandboxId, ms),
    writeFile: (sandboxId, path, contents) => inner.writeFile(sandboxId, path, contents),
    readFile: (sandboxId, path) => inner.readFile(sandboxId, path),
    listFiles: (sandboxId, path) => inner.listFiles(sandboxId, path),
    exec: (sandboxId, command, onOutput) => inner.exec(sandboxId, command, onOutput),
    // Composing an address costs nothing in a real deployment either — it is string work.
    getPreviewUrl: (sandboxId, port) => inner.getPreviewUrl(sandboxId, port),
    waitForPreview: async (sandboxId, port, opts) => {
      await sleep(CALIBRATION.previewRenderMs);
      return await inner.waitForPreview(sandboxId, port, opts);
    },
  };

  return slowed;
}

/**
 * A provider whose turns take as long as real turns took.
 *
 * The duration is drawn once per *turn* and spent before the turn's first answer, rather than
 * split across its calls. The recorded figure is a turn duration; how it divides between one
 * model round trip and the next was not recorded, and a split invented here would be a
 * statement about model behaviour that no run supports. Spending it up front keeps the thing
 * that was measured — how long a user waits for a turn — exactly right.
 */
export function slowLLMProvider(inner: LLMProvider, options: SlowOptions = {}): LLMProvider {
  const sleep = options.sleep ?? realSleep;
  const random = options.random ?? Math.random;

  return {
    startTurn: (turnOptions) => {
      const underlying = inner.startTurn(turnOptions);
      let owed = sampleRange(CALIBRATION.turnMs, random);

      const turn: LLMTurn = {
        complete: async (request: LLMRequest) => {
          if (owed > 0) {
            await sleep(owed);
            owed = 0;
          }
          return await underlying.complete(request);
        },
        usage: () => underlying.usage(),
      };

      return turn;
    },
  };
}
