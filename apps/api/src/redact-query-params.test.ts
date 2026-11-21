import { describe, expect, it } from "vitest";
import { withoutQueryParams } from "./redact-query-params.ts";

/**
 * The end-to-end claim — a real failed query, through pino, leaves no parameters — is in
 * `logger.test.ts` and `auth/auth-log.test.ts`. These pin the edges that claim rests on: what
 * is left alone, and the shapes a real error does not happen to take today.
 */

const DRIZZLE_MESSAGE = 'Failed query: select 1 where "token" = $1\nparams: s3cret,\nsecond line';

/** Shaped as Drizzle builds one: message, enumerable `query` and `params`, and a cause. */
function aQueryError(): Error {
  const error = new Error(DRIZZLE_MESSAGE, { cause: new Error("connect ECONNREFUSED") });
  return Object.assign(error, { query: 'select 1 where "token" = $1', params: ["s3cret"] });
}

describe("withoutQueryParams", () => {
  it("returns an ordinary value as the same reference", () => {
    const error = new Error("plain", { cause: new Error("inner") });
    const fields = { err: error, ids: ["a", "b"], n: 1 };

    expect(withoutQueryParams(error)).toBe(error);
    expect(withoutQueryParams(fields)).toBe(fields);
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
    const copy = withoutQueryParams(original);

    expect(copy).toBeInstanceOf(Error);
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
    const value = { failure: { ok: false, errors: [wrapped] } };

    const serialized = JSON.stringify(withoutQueryParams(value), (_key, field: unknown) =>
      field instanceof Error ? { ...field, message: field.message, stack: field.stack } : field,
    );

    expect(serialized).toContain("could not sweep");
    expect(serialized).not.toContain("s3cret");
  });

  it("stops at a cycle rather than recursing forever", () => {
    const fields: Record<string, unknown> = { message: DRIZZLE_MESSAGE };
    fields.self = fields;

    const result = withoutQueryParams(fields);

    expect(result.message).not.toContain("s3cret");
  });
});
