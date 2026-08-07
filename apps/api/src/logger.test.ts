import { describe, expect, it } from "vitest";
import { createLogger, getLogger, withLogContext } from "./logger.ts";

/**
 * The bar these tests hold the logger to is the observability goal: grep one `turnId` and
 * reconstruct a whole turn. That only works if context reaches code that was never handed a
 * logger, which is why `withLogContext` exists and why these assertions go through
 * `getLogger()` rather than through a logger passed in as an argument.
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
});

describe("withLogContext", () => {
  it("puts sessionId on lines emitted by code that never received a logger", () => {
    const sink = capture();
    const root = createLogger({ level: "info" }, sink.stream);

    // Stands in for anything deep in a call stack — a port implementation, say — that has
    // no logger parameter and cannot be given one without changing its interface.
    const deeplyNested = () => getLogger().info("did a thing");

    withLogContext(root, { sessionId: "s1" }, () => {
      deeplyNested();
    });

    expect(sink.records()[0]).toMatchObject({ sessionId: "s1", msg: "did a thing" });
  });

  it("merges nested context rather than replacing it", () => {
    const sink = capture();
    const root = createLogger({ level: "info" }, sink.stream);

    withLogContext(root, { sessionId: "s1" }, () => {
      withLogContext(getLogger(), { turnId: "t1" }, () => {
        getLogger().info("inner");
      });
      getLogger().info("outer again");
    });

    const [inner, outer] = sink.records();
    expect(inner).toMatchObject({ sessionId: "s1", turnId: "t1" });
    // Leaving the inner context must not leak turnId into later lines.
    expect(outer).toMatchObject({ sessionId: "s1" });
    expect(outer).not.toHaveProperty("turnId");
  });

  it("keeps context across an await, which is the case that actually matters", () => {
    const sink = capture();
    const root = createLogger({ level: "info" }, sink.stream);

    return withLogContext(root, { turnId: "t1" }, async () => {
      await Promise.resolve();
      getLogger().info("after await");
      expect(sink.records()[0]).toMatchObject({ turnId: "t1" });
    });
  });

  it("returns the callback's value", () => {
    const root = createLogger({ level: "silent" }, capture().stream);
    expect(withLogContext(root, { sessionId: "s1" }, () => 42)).toBe(42);
  });
});

describe("getLogger outside any context", () => {
  it("does not throw, so library code never fails for want of a request", () => {
    expect(() => getLogger()).not.toThrow();
    expect(() => getLogger().info("no context here")).not.toThrow();
  });
});
