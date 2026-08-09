import { describe, expect, it } from "vitest";
import { parseEnv } from "./env.ts";

/**
 * `parseEnv` takes a plain record rather than reading `process.env`, so these tests never
 * mutate global state and never depend on what happens to be exported in the shell.
 */

const VALID = {
  DATABASE_URL: "postgres://nap:nap@localhost:5432/nap",
  E2B_API_KEY: "e2b_test",
  ANTHROPIC_API_KEY: "sk-ant-test",
  PORT: "3001",
  LOG_LEVEL: "info",
  NODE_ENV: "development",
} as const;

/** Only the keys with no default. */
const REQUIRED = {
  DATABASE_URL: VALID.DATABASE_URL,
  E2B_API_KEY: VALID.E2B_API_KEY,
  ANTHROPIC_API_KEY: VALID.ANTHROPIC_API_KEY,
} as const;

describe("parseEnv", () => {
  it("accepts a complete environment", () => {
    const env = parseEnv(VALID);
    expect(env.DATABASE_URL).toBe(VALID.DATABASE_URL);
    expect(env.NODE_ENV).toBe("development");
  });

  it.each(["E2B_API_KEY", "ANTHROPIC_API_KEY"])("requires %s", (key) => {
    // The server now creates sandboxes and calls the model itself. Both keys become required
    // in the task that first reads them, which is this one — a process that boots without
    // them only fails on the first message someone sends.
    const { [key as keyof typeof REQUIRED]: _omitted, ...rest } = REQUIRED;

    expect(() => parseEnv(rest)).toThrow(new RegExp(key));
  });

  it("wants AWS credentials instead when the models are reached through Bedrock", () => {
    // Not a second vendor — the same models billed to an AWS account. Demanding an Anthropic
    // key from someone paying through AWS is exactly the kind of check that teaches people to
    // paste dummy values.
    const bedrock = {
      DATABASE_URL: VALID.DATABASE_URL,
      E2B_API_KEY: VALID.E2B_API_KEY,
      NAP_PLATFORM: "bedrock",
      AWS_BEARER_TOKEN_BEDROCK: "ABSK-test",
      AWS_REGION: "us-east-1",
    };

    expect(parseEnv(bedrock).NAP_PLATFORM).toBe("bedrock");
  });

  it.each(["AWS_BEARER_TOKEN_BEDROCK", "AWS_REGION"])("requires %s on Bedrock", (key) => {
    // The region especially: the Bedrock client throws at *construction* without one, so a
    // missing region is a stack trace at boot rather than a sentence naming the variable.
    const bedrock: Record<string, string> = {
      DATABASE_URL: VALID.DATABASE_URL,
      E2B_API_KEY: VALID.E2B_API_KEY,
      NAP_PLATFORM: "bedrock",
      AWS_BEARER_TOKEN_BEDROCK: "ABSK-test",
      AWS_REGION: "us-east-1",
    };
    delete bedrock[key];

    expect(() => parseEnv(bedrock)).toThrow(new RegExp(key));
  });

  it("does not ask for an Anthropic key on the Bedrock path", () => {
    expect(() =>
      parseEnv({
        DATABASE_URL: VALID.DATABASE_URL,
        E2B_API_KEY: VALID.E2B_API_KEY,
        NAP_PLATFORM: "bedrock",
        AWS_BEARER_TOKEN_BEDROCK: "ABSK-test",
        AWS_REGION: "us-east-1",
      }),
    ).not.toThrow();
  });

  it("defaults the model to the cheap one", () => {
    // Every message typed into the box spends money. What it spends by default is a decision,
    // and the default is the same model `harness --real` uses.
    const env = parseEnv(REQUIRED);

    expect(env.NAP_MODEL).toBe("claude-sonnet-5");
    expect(env.NAP_EFFORT).toBe("medium");
  });

  it("takes a different model when one is asked for", () => {
    const env = parseEnv({ ...REQUIRED, NAP_MODEL: "claude-opus-5", NAP_EFFORT: "xhigh" });

    expect(env.NAP_MODEL).toBe("claude-opus-5");
    expect(env.NAP_EFFORT).toBe("xhigh");
  });

  it("rejects an effort level the provider would refuse", () => {
    expect(() => parseEnv({ ...REQUIRED, NAP_EFFORT: "maximum" })).toThrow(/NAP_EFFORT/);
  });

  it("coerces the numeric budgets", () => {
    const env = parseEnv({ ...REQUIRED, NAP_MAX_STEPS: "20", NAP_CONTEXT_BUDGET_TOKENS: "80000" });

    expect(env.NAP_MAX_STEPS).toBe(20);
    expect(env.NAP_CONTEXT_BUDGET_TOKENS).toBe(80_000);
  });

  it("coerces PORT to a number", () => {
    // Everything in an environment is a string; the rest of the app should not have to
    // remember that.
    expect(parseEnv(VALID).PORT).toBe(3001);
    expect(typeof parseEnv(VALID).PORT).toBe("number");
  });

  it("applies defaults for the optional keys", () => {
    const env = parseEnv(REQUIRED);
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
    for (const key of ["DATABASE_URL", "PORT", "LOG_LEVEL", "NODE_ENV"] as const) {
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
