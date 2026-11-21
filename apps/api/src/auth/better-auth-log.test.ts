import { format } from "node:util";
import { type Logger, withLogContext } from "@nap/shared/logging";
import { describe, expect, it } from "vitest";
import { createLogger } from "../logger.ts";
import { logFromBetterAuth } from "./better-auth-log.ts";

/**
 * The shapes Better Auth 1.6 actually calls its logger with, each found by reading the library:
 * `logger.error(status, error)`, `logger.error(error)` (the list-sessions route), and
 * `logger.error(text, { where, limit })` (the adapter's follow-up read). The end-to-end check is
 * `auth-log.test.ts`; these pin what each shape becomes.
 */

/** Runs `log` under a captured pino logger and returns the parsed lines. */
function linesOf(log: () => void): Record<string, unknown>[] {
  const lines: string[] = [];
  const root = createLogger({ level: "debug" }, { write: (line: string) => lines.push(line) });
  withLogContext(root, { requestId: "r1" }, log);
  return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
}

const queryError = () =>
  Object.assign(new Error('Failed query: select 1 where "id" = $1\nparams: user-123'), {
    params: ["user-123"],
    cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), {
      code: "ECONNREFUSED",
    }),
  });

describe("logFromBetterAuth", () => {
  it("logs an error passed after a message as err, under the request's ids", () => {
    const [line] = linesOf(() =>
      logFromBetterAuth("error", "INTERNAL_SERVER_ERROR", [queryError()]),
    );

    expect(line).toMatchObject({
      level: 50,
      requestId: "r1",
      msg: "[Better Auth] INTERNAL_SERVER_ERROR",
      err: { message: expect.stringContaining("ECONNREFUSED") },
    });
    expect(JSON.stringify(line)).not.toContain("user-123");
  });

  it("keeps the cause when the error itself is passed as the message", () => {
    const [line] = linesOf(() => logFromBetterAuth("error", queryError(), []));

    expect(line).toMatchObject({
      msg: "[Better Auth]",
      err: { message: expect.stringContaining("ECONNREFUSED") },
    });
    expect(JSON.stringify(line)).not.toContain("user-123");
  });

  it("withholds the values of a where clause and keeps which field it was", () => {
    const where = [{ field: "id", value: "user-123", operator: "eq", connector: "AND" }];

    const [line] = linesOf(() =>
      logFromBetterAuth("error", "Failed to query fallback join for model users:", [
        { where, limit: undefined },
      ]),
    );

    expect(JSON.stringify(line)).not.toContain("user-123");
    expect(line).toMatchObject({ args: [{ where: [{ field: "id", operator: "eq" }] }] });
  });

  it("passes other arguments through", () => {
    const [line] = linesOf(() =>
      logFromBetterAuth("warn", "Provider not found", [{ provider: "github" }]),
    );

    expect(line).toMatchObject({ level: 40, args: [{ provider: "github" }] });
  });

  it("redacts on its own, under a root logger that does not", () => {
    // The guarantee does not lean on pino's hook: a recorder that prints whatever it is handed,
    // as `console` would, is still given nothing to leak.
    const written: string[] = [];
    const recorder: Logger = {
      child: () => recorder,
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: (fields: object | string, message?: string) => {
        written.push(format(fields, message));
      },
    };

    withLogContext(recorder, {}, () =>
      logFromBetterAuth("error", "INTERNAL_SERVER_ERROR", [queryError()]),
    );

    expect(written).toHaveLength(1);
    expect(written[0]).toContain("Failed query:");
    expect(written[0]).not.toContain("user-123");
  });
});
