import { createDatabase } from "@nap/db/client";
import { authSessions } from "@nap/db/schema";
import { getLogger, withLogContext } from "@nap/shared/logging";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createLogger } from "./logger.ts";

/**
 * The context semantics are `@nap/shared/logging`'s and are tested there. What is left for
 * here is the half this module owns: that a real pino logger writes what we expect, and that
 * it works as the `Logger` the whole repo is written against — which a recorder in the base
 * package's tests cannot prove.
 */

/** Collects written lines so assertions run on real output rather than on mock calls. */
function capture() {
  const lines: string[] = [];
  return {
    lines,
    stream: {
      write(msg: string) {
        lines.push(msg);
      },
    },
    /** Each pino line is one JSON object; parse them so tests assert on fields, not text. */
    records(): Record<string, unknown>[] {
      return lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    },
  };
}

describe("createLogger", () => {
  it("emits one JSON object per line", () => {
    const sink = capture();
    const logger = createLogger({ level: "info" }, sink.stream);

    logger.info("first");
    logger.info("second");

    expect(sink.lines).toHaveLength(2);
    expect(() => sink.records()).not.toThrow();
  });

  it("includes the expected fields", () => {
    const sink = capture();
    createLogger({ level: "info" }, sink.stream).info({ projectId: "p1" }, "hello");

    const [record] = sink.records();
    expect(record).toMatchObject({ level: expect.any(Number), msg: "hello", projectId: "p1" });
    expect(record?.time).toEqual(expect.any(Number));
  });

  it("honours the configured level", () => {
    const sink = capture();
    const logger = createLogger({ level: "warn" }, sink.stream);

    logger.info("suppressed");
    logger.warn("kept");

    expect(sink.records().map((r) => r.msg)).toEqual(["kept"]);
  });

  it("carries ambient context onto real output", () => {
    const sink = capture();
    const root = createLogger({ level: "info" }, sink.stream);

    // The end-to-end claim: pino's `child` is what `withLogContext` calls, so the ids reach a
    // line written by code holding no logger at all. Both halves are tested apart; this is
    // the one assertion that they fit together.
    withLogContext(root, { turnId: "t1", userId: "u1" }, () => {
      getLogger().info({ step: 2 }, "deep in the stack");
    });

    expect(sink.records()[0]).toMatchObject({
      turnId: "t1",
      userId: "u1",
      step: 2,
      msg: "deep in the stack",
    });
  });
});

describe("a failed database query, logged", () => {
  /**
   * A real `DrizzleQueryError`, not a hand-built one: what leaks is the library's own message
   * (`params:` and the values), its enumerable `params` field and its stack, and a copy could
   * drift from all three. Port 1 refuses at once, so no database is needed.
   */
  async function aFailedQuery(secret: string): Promise<unknown> {
    const unreachable = createDatabase("postgres://nap:nap@127.0.0.1:1/nap", { max: 1 });
    try {
      await unreachable.db.select().from(authSessions).where(eq(authSessions.token, secret));
    } catch (error) {
      return error;
    } finally {
      await unreachable.close();
    }
    throw new Error("the query against a closed port succeeded");
  }

  it("keeps the query and the cause, and drops the parameters wherever the error is put", async () => {
    const secret = `secret-${crypto.randomUUID()}`;
    const error = await aFailedQuery(secret);
    const sink = capture();
    const logger = createLogger({ level: "info" }, sink.stream);

    // Every way this repo hands an error to the logger: the `err` key pino serializes, an error
    // inside a typed result (`{ failure }`), one wrapped as another's cause, and its message
    // used as the line itself.
    logger.error({ err: error }, "as err");
    logger.error({ failure: { ok: false, error } }, "inside a result");
    logger.error({ err: new Error("could not sweep", { cause: error }) }, "as a cause");
    logger.child({ turnId: "t1" }).warn({}, error instanceof Error ? error.message : "");

    expect(sink.lines).toHaveLength(4);
    const written = sink.lines.join("\n");
    expect(written).not.toContain(secret);
    expect(written).not.toContain("params:");
    // What a reader needs is still there: which query, and why it failed.
    for (const line of sink.lines) expect(line).toContain("auth_sessions");
    // pino folds the cause into the serialized error's message and stack.
    expect(sink.records()[0]).toMatchObject({
      err: {
        type: "DrizzleQueryError",
        message: expect.stringContaining("ECONNREFUSED"),
        // The failed query's own frame, not only the cause's: the copy keeps its stack.
        stack: expect.stringContaining("queryWithCache"),
      },
    });
  });
});
