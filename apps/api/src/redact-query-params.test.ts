import { readFileSync } from "node:fs";
import { format } from "node:util";
import { describe, expect, it } from "vitest";
import { createLogger } from "./logger.ts";
import { redactConsole, withoutQueryParams } from "./redact-query-params.ts";

/**
 * The end-to-end claim — a real failed query, through pino, leaves no parameters — is in
 * `logger.test.ts` and `auth/auth-log.test.ts`. These pin the edges that claim rests on: what
 * is left alone, and the shapes a real error does not happen to take today.
 */

const DRIZZLE_MESSAGE = 'Failed query: select 1 where "token" = $1\nparams: s3cret,\nsecond line';

/**
 * Built as Drizzle builds one: the message, then `query`, `params` and `cause` assigned, which
 * makes all three enumerable — `cause` included, unlike the `Error` constructor's option.
 */
function aQueryError(query = 'select 1 where "token" = $1'): Error {
  return Object.assign(new Error(`Failed query: ${query}\nparams: s3cret,\nsecond line`), {
    query,
    params: ["s3cret"],
    cause: new Error("connect ECONNREFUSED"),
  });
}

/** What pino writes for these fields, which is the only output that matters. */
function logged(fields: object): string {
  const lines: string[] = [];
  createLogger({ level: "info" }, { write: (line: string) => lines.push(line) }).error(fields, "x");
  return lines.join("\n");
}

function asError(value: unknown): Error {
  if (!(value instanceof Error)) throw new Error(`expected an error, got ${String(value)}`);
  return value;
}

describe("withoutQueryParams", () => {
  it("returns an ordinary value as the same reference", () => {
    const error = new Error("plain", { cause: new Error("inner") });
    const fields = { err: error, ids: ["a", "b"], n: 1 };
    const cyclic: Record<string, unknown> = { n: 1 };
    cyclic.self = cyclic;

    expect(withoutQueryParams(error)).toBe(error);
    expect(withoutQueryParams(fields)).toBe(fields);
    expect(withoutQueryParams(cyclic)).toBe(cyclic);
    expect(withoutQueryParams("no query here\nparams: fine")).toBe("no query here\nparams: fine");
  });

  it("cuts a message at its parameters, newlines in them included", () => {
    const text = withoutQueryParams(`wrapped: ${DRIZZLE_MESSAGE}`);

    expect(text).toContain('wrapped: Failed query: select 1 where "token" = $1');
    expect(text).not.toContain("s3cret");
    expect(text).not.toContain("second line");
    expect(text).not.toContain("params:");
  });

  it("copies the error without its parameters, keeping type, query, frames and cause", () => {
    const original = aQueryError();
    const copy = asError(withoutQueryParams(original));

    expect(copy).not.toBe(original);
    expect(Object.keys(copy)).not.toContain("params");
    expect(copy.message).not.toContain("s3cret");
    expect(copy.stack).not.toContain("s3cret");
    expect(copy.stack).toContain("    at ");
    expect(copy).toMatchObject({ query: 'select 1 where "token" = $1' });
    expect(copy.cause).toBe(original.cause);
    // The original is untouched: whoever threw it may still be holding it.
    expect(original).toMatchObject({ params: ["s3cret"] });
  });

  it("finds a query error as a cause, in an array, or inside a typed result", () => {
    const wrapped = new Error("could not sweep", { cause: aQueryError() });
    const output = logged({ failure: { ok: false, errors: [wrapped] }, err: wrapped });

    expect(output).toContain("could not sweep");
    expect(output).not.toContain("s3cret");
  });

  it("redacts every reference to the same error, not only the first", () => {
    const error = aQueryError();

    expect(logged({ err: error, again: { err: error }, list: [error, error] })).not.toContain(
      "s3cret",
    );
  });

  it("writes a cycle back to a query error without the original's fields", () => {
    const fields: Record<string, unknown> = { err: aQueryError() };
    fields.self = fields;

    const output = logged(fields);

    expect(output).not.toContain("s3cret");
    expect(output).toContain("[Circular]");
  });

  it("withholds what is nested too deeply to check, rather than passing it through", () => {
    let fields: Record<string, unknown> = { err: aQueryError() };
    for (let i = 0; i < 40; i++) fields = { inner: fields };

    expect(logged(fields)).not.toContain("s3cret");
  });

  it("keeps a `$&` in the query from putting the original message back into the stack", () => {
    const copy = asError(withoutQueryParams(aQueryError('select "$&", $1')));

    expect(copy.stack).toContain('select "$&", $1');
    expect(copy.stack).not.toContain("s3cret");
  });

  it("drops a Postgres error's detail, which repeats the rejected value", () => {
    const cause = Object.assign(new Error("duplicate key value violates unique constraint"), {
      name: "PostgresError",
      code: "23505",
      detail: "Key (email)=(someone@example.com) already exists.",
      constraint_name: "users_email_unique",
    });
    const error = Object.assign(aQueryError(), { cause });

    const output = logged({ failure: { error } });

    expect(output).not.toContain("someone@example.com");
    expect(output).toContain("users_email_unique");
  });

  it("never throws, whatever the error's fields do", () => {
    const hostile = new Error("plain");
    Object.defineProperty(hostile, "diagnostics", {
      get() {
        throw new Error("getter threw");
      },
    });
    const nullMessage = Object.assign(new Error("x"), { message: null });

    expect(() => logged({ err: hostile })).not.toThrow();
    expect(() => logged({ err: nullMessage })).not.toThrow();
    expect(() => logged({ err: Object.assign(aQueryError(), { message: null }) })).not.toThrow();
  });
});

describe("redactConsole", () => {
  it("strips the parameters from what a library prints with console directly", () => {
    const written: string[] = [];
    const target = {
      ...console,
      error: (...args: unknown[]) => written.push(format(...args)),
    } as Console;

    redactConsole(target);
    target.error(aQueryError());

    expect(written).toHaveLength(1);
    expect(written[0]).toContain("Failed query:");
    expect(written[0]).not.toContain("s3cret");
  });
});

describe("boot", () => {
  // `bootNap` reads the real environment and opens real connections, so it is not called from
  // a unit test; the one line that matters is checked in its source instead. Without it, the
  // console path `auth/auth-log.db.test.ts` proves is only proven for tests.
  it("routes console through redactConsole in every process", () => {
    const source = readFileSync(new URL("./boot.ts", import.meta.url), "utf8");

    expect(source).toMatch(/^\s+redactConsole\(\);$/m);
  });
});
