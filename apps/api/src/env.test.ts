import { describe, expect, it } from "vitest";
import { parseEnv } from "./env.ts";

/**
 * `parseEnv` takes a plain record rather than reading `process.env`, so these tests never
 * mutate global state and never depend on what happens to be exported in the shell.
 */

const VALID = {
  DATABASE_URL: "postgres://nap:nap@localhost:5432/nap",
  PORT: "3001",
  LOG_LEVEL: "info",
  NODE_ENV: "development",
} as const;

describe("parseEnv", () => {
  it("accepts a complete environment", () => {
    const env = parseEnv(VALID);
    expect(env.DATABASE_URL).toBe(VALID.DATABASE_URL);
    expect(env.NODE_ENV).toBe("development");
  });

  it("coerces PORT to a number", () => {
    // Everything in an environment is a string; the rest of the app should not have to
    // remember that.
    expect(parseEnv(VALID).PORT).toBe(3001);
    expect(typeof parseEnv(VALID).PORT).toBe("number");
  });

  it("applies defaults for the optional keys", () => {
    const env = parseEnv({ DATABASE_URL: VALID.DATABASE_URL });
    expect(env.PORT).toBe(3001);
    expect(env.LOG_LEVEL).toBe("info");
    expect(env.NODE_ENV).toBe("development");
  });
});

describe("parseEnv failure", () => {
  it("names every missing key, not just the first", () => {
    // The whole point of validating at boot: one run should tell you everything to fix.
    // Reporting only the first key turns setup into a guessing game.
    let message = "";
    try {
      parseEnv({ LOG_LEVEL: "info" });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("DATABASE_URL");
  });

  it("names every invalid key when several are wrong at once", () => {
    let message = "";
    try {
      parseEnv({ DATABASE_URL: "", PORT: "not-a-number", LOG_LEVEL: "loud", NODE_ENV: "banana" });
    } catch (error) {
      message = (error as Error).message;
    }
    for (const key of ["DATABASE_URL", "PORT", "LOG_LEVEL", "NODE_ENV"]) {
      expect(message).toContain(key);
    }
  });

  it("rejects a non-numeric PORT", () => {
    expect(() => parseEnv({ ...VALID, PORT: "http" })).toThrow(/PORT/);
  });

  it("rejects an unknown LOG_LEVEL rather than silently defaulting", () => {
    expect(() => parseEnv({ ...VALID, LOG_LEVEL: "chatty" })).toThrow(/LOG_LEVEL/);
  });

  it("throws rather than returning a result, because a bad env is not a recoverable state", () => {
    expect(() => parseEnv({})).toThrow();
  });
});
