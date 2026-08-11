import { beforeEach, describe, expect, it } from "vitest";
import {
  addLogContext,
  getLogger,
  type LogContext,
  type Logger,
  setRootLogger,
  withLogContext,
} from "./logging.ts";

/**
 * The bar these tests hold the seam to is the observability goal: grep one `turnId` and
 * reconstruct a whole turn. That only works if context reaches code that was never handed a
 * logger, which is why the assertions go through `getLogger()` rather than through a logger
 * passed in as an argument.
 */

type Line = { fields: Record<string, unknown>; message: string; level: string };

/** A `Logger` that records instead of writing, so assertions run on fields rather than text. */
function recorder(bindings: Record<string, unknown> = {}, lines: Line[] = []) {
  const at =
    (level: string) =>
    (first: object | string, second?: string): void => {
      lines.push(
        typeof first === "string"
          ? { fields: { ...bindings }, message: first, level }
          : { fields: { ...bindings, ...first }, message: second ?? "", level },
      );
    };

  const logger: Logger = {
    child: (extra) => recorder({ ...bindings, ...extra }, lines).logger,
    debug: at("debug"),
    info: at("info"),
    warn: at("warn"),
    error: at("error"),
  };

  return { logger, lines };
}

beforeEach(() => {
  // The root is process-wide, so a test that sets one would otherwise leak into the next.
  setRootLogger(recorder().logger);
});

describe("withLogContext", () => {
  it("puts sessionId on lines emitted by code that never received a logger", () => {
    const { logger, lines } = recorder();

    // Stands in for anything deep in a call stack — a port implementation, say — that has
    // no logger parameter and cannot be given one without changing its interface.
    const deeplyNested = () => getLogger().info("did a thing");

    withLogContext(logger, { sessionId: "s1" }, () => {
      deeplyNested();
    });

    expect(lines[0]).toMatchObject({ fields: { sessionId: "s1" }, message: "did a thing" });
  });

  it("merges nested context rather than replacing it", () => {
    const { logger, lines } = recorder();

    withLogContext(logger, { sessionId: "s1" }, () => {
      withLogContext(getLogger(), { turnId: "t1" }, () => {
        getLogger().info("inner");
      });
      getLogger().info("outer again");
    });

    const [inner, outer] = lines;
    expect(inner?.fields).toMatchObject({ sessionId: "s1", turnId: "t1" });
    // Leaving the inner context must not leak turnId into later lines.
    expect(outer?.fields).toMatchObject({ sessionId: "s1" });
    expect(outer?.fields).not.toHaveProperty("turnId");
  });

  it("keeps context across an await, which is the case that actually matters", async () => {
    const { logger, lines } = recorder();

    await withLogContext(logger, { turnId: "t1" }, async () => {
      await Promise.resolve();
      getLogger().info("after await");
    });

    expect(lines[0]?.fields).toMatchObject({ turnId: "t1" });
  });

  it("keeps context in work that outlives the call, which is how a detached turn logs", async () => {
    const { logger, lines } = recorder();

    // A turn is started inside a request and answered with a 202 — the promise settles long
    // after the context was left. Losing the ids there would lose the whole turn's logs.
    const detached = withLogContext(logger, { turnId: "t1" }, () =>
      Promise.resolve().then(() => {
        getLogger().info("much later");
      }),
    );

    await detached;
    expect(lines[0]?.fields).toMatchObject({ turnId: "t1" });
  });

  it("returns the callback's value", () => {
    expect(withLogContext(recorder().logger, { sessionId: "s1" }, () => 42)).toBe(42);
  });
});

describe("addLogContext", () => {
  it("enriches the context in place, so a later getLogger() sees it", () => {
    const { logger, lines } = recorder();

    withLogContext(logger, { requestId: "r1" }, () => {
      // Whoever learns the caller's id is not whoever opened the context — authentication runs
      // in a middleware below the one that starts the request. Without this the userId would be
      // stuck in a nested scope and the request's own summary line could not carry it.
      addLogContext({ userId: "u1" });
      getLogger().info("after");
    });

    expect(lines[0]?.fields).toMatchObject({ requestId: "r1", userId: "u1" });
  });

  it("does not escape the context it was added in", () => {
    const { logger, lines } = recorder();

    withLogContext(logger, { requestId: "r1" }, () => {
      withLogContext(getLogger(), { turnId: "t1" }, () => {
        addLogContext({ projectId: "p1" });
      });
      getLogger().info("outer");
    });

    expect(lines[0]?.fields).not.toHaveProperty("projectId");
  });

  it("does nothing outside a context rather than throwing", () => {
    expect(() => addLogContext({ userId: "u1" })).not.toThrow();
  });
});

describe("getLogger outside any context", () => {
  it("does not throw, so library code never fails for want of a request", () => {
    expect(() => getLogger()).not.toThrow();
    expect(() => getLogger().info("no context here")).not.toThrow();
  });

  it("uses whatever root was installed, so lines from scripts still go somewhere", () => {
    const { logger, lines } = recorder();
    setRootLogger(logger);

    getLogger().warn({ where: "a script" }, "no request here");

    expect(lines[0]).toMatchObject({ level: "warn", message: "no request here" });
  });

  it("defaults to a logger that discards, so importing this never writes to stdout", () => {
    // Nothing has called setRootLogger in a fresh process — a package's own unit tests, say.
    // A default that printed would put JSON in the middle of every test run's output.
    const fields: LogContext = { turnId: "t1" };
    expect(() => getLogger().child(fields).error({ err: "x" }, "boom")).not.toThrow();
  });
});
