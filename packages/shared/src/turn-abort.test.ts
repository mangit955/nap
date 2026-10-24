import { expect, it } from "vitest";
import { TurnAbortError } from "./turn-abort.ts";

it.each(["lease_lost", "cancelled", "shutdown"] as const)(
  "keeps the structural abort reason %s",
  (code) => {
    const error = new TurnAbortError(code);
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe(code);
    expect(error.message.length).toBeGreaterThan(0);
  },
);

it("remembers authority loss after an earlier cancellation without changing the first reason", () => {
  const error = new TurnAbortError("cancelled");
  expect(error.leaseLost).toBe(false);
  error.markLeaseLost();
  expect(error.leaseLost).toBe(true);
  expect(error.code).toBe("cancelled");
});
