import type { LogContext, Logger } from "@nap/shared/logging";
import { describe, expect, it } from "vitest";
import { announce } from "./boot-line.ts";
import type { Env } from "./env.ts";

/**
 * The boot line — the half of booting that can be held by a suite running on Node.
 *
 * `bootNap` cannot: it opens a Postgres pool, an E2B client and an R2 client from real
 * credentials, and it imports `hono/bun`, which does not exist off Bun. So it is proven by
 * starting a process, the same bargain `index.ts` has always had. What *is* testable is the thing
 * an operator actually reads, and there is a
 * reason to: a boot line naming the wrong model or the wrong bus is worse than none, because it
 * is believed. Two pods disagreeing about either is exactly what these fields exist to show.
 */

/** A logger that keeps what it was given, which is all this needs of one. */
function recorder(): Logger & { lines: { fields: LogContext & object; message: string }[] } {
  const lines: { fields: LogContext & object; message: string }[] = [];
  const log = (fields: unknown, message?: unknown) => {
    if (typeof fields === "string") {
      lines.push({ fields: {}, message: fields });
      return;
    }
    lines.push({ fields: fields as LogContext & object, message: String(message) });
  };

  const logger: Logger & { lines: typeof lines } = {
    lines,
    child: () => logger,
    debug: log,
    info: log,
    warn: log,
    error: log,
  };
  return logger;
}

const ENV = {
  NODE_ENV: "production",
  NAP_PLATFORM: "openrouter",
  NAP_EVENT_BUS: "postgres",
  NAP_MODEL: "openai/gpt-5.6-luna",
  NAP_EFFORT: "medium",
} as Env;

describe("the boot line", () => {
  it("names what this process will spend money on, and which half it is", () => {
    const logger = recorder();

    announce({ env: ENV, role: "worker", logger }, "worker claiming", { concurrency: 25 });

    expect(logger.lines).toHaveLength(1);
    expect(logger.lines[0]?.message).toBe("worker claiming");
    expect(logger.lines[0]?.fields).toMatchObject({
      role: "worker",
      platform: "openrouter",
      // The one that turns "the chat stopped moving" into a five-second diagnosis.
      eventBus: "postgres",
      model: "openai/gpt-5.6-luna",
      effort: "medium",
      // Whatever the entrypoint added, alongside rather than instead of the shared fields.
      concurrency: 25,
    });
  });
});
