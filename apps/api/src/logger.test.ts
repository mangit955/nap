import { getLogger, withLogContext } from "@nap/shared/logging";
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
