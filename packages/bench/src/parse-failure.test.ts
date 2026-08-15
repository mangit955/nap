import { describe, expect, it } from "vitest";
import { z } from "zod";
import { describeParseFailure } from "./parse-failure.ts";

const schema = z.strictObject({ id: z.string().min(1), nested: z.object({ n: z.number() }) });

function errorFrom(input: unknown): z.ZodError {
  const parsed = schema.safeParse(input);
  if (parsed.success) throw new Error("expected this input to fail parsing");
  return parsed.error;
}

describe("describeParseFailure", () => {
  it("names the field that was wrong", () => {
    expect(describeParseFailure(errorFrom({ id: "", nested: { n: 1 } }), "thing")).toContain("id:");
  });

  it("spells a nested path with dots, so it can be found in the file", () => {
    expect(describeParseFailure(errorFrom({ id: "a", nested: { n: "x" } }), "thing")).toContain(
      "nested.n:",
    );
  });

  it("falls back to the label when the whole value is wrong", () => {
    // A top-level failure has an empty path, and `": expected object"` would tell nobody
    // which of the several things a CLI parses had the problem.
    expect(describeParseFailure(errorFrom("not an object at all"), "task")).toMatch(/^task: /);
  });

  it("joins several problems into one sentence rather than reporting only the first", () => {
    const described = describeParseFailure(errorFrom({ id: "", nested: { n: "x" } }), "thing");

    expect(described).toContain("; ");
  });
});
