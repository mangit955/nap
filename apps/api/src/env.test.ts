import { describe, expect, it } from "vitest";
import { parseEnv } from "./env.ts";

/**
 * `parseEnv` takes a plain record rather than reading `process.env`, so these tests never
 * mutate global state and never depend on what happens to be exported in the shell.
 */

/** The bucket a project's bytes live in while nothing is running. */
const R2 = {
  R2_ACCOUNT_ID: "0123456789abcdef",
  R2_BUCKET: "nap-snapshots",
  R2_ACCESS_KEY_ID: "r2-key",
  R2_SECRET_ACCESS_KEY: "r2-secret",
} as const;

const VALID = {
  DATABASE_URL: "postgres://nap:nap@localhost:5432/nap",
  E2B_API_KEY: "e2b_test",
  // The default platform, so this is the key a default configuration needs.
  OPENROUTER_API_KEY: "sk-or-test",
  BETTER_AUTH_SECRET: "a-secret-long-enough-to-sign-a-cookie-with",
  // 32 bytes of base64, which is what seals the API keys people bring with them.
  NAP_KEY_ENCRYPTION_SECRET: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  ...R2,
  PORT: "3001",
  LOG_LEVEL: "info",
  NODE_ENV: "development",
} as const;

/** Only the keys with no default. */
const REQUIRED = {
  DATABASE_URL: VALID.DATABASE_URL,
  E2B_API_KEY: VALID.E2B_API_KEY,
  OPENROUTER_API_KEY: VALID.OPENROUTER_API_KEY,
  BETTER_AUTH_SECRET: VALID.BETTER_AUTH_SECRET,
  NAP_KEY_ENCRYPTION_SECRET: VALID.NAP_KEY_ENCRYPTION_SECRET,
  ...R2,
} as const;

describe("parseEnv", () => {
  it("accepts a complete environment", () => {
    const env = parseEnv(VALID);
    expect(env.DATABASE_URL).toBe(VALID.DATABASE_URL);
    expect(env.NODE_ENV).toBe("development");
  });

  it.each(["E2B_API_KEY", "OPENROUTER_API_KEY", "BETTER_AUTH_SECRET"])("requires %s", (key) => {
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
      BETTER_AUTH_SECRET: VALID.BETTER_AUTH_SECRET,
      NAP_KEY_ENCRYPTION_SECRET: VALID.NAP_KEY_ENCRYPTION_SECRET,
      ...R2,
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
      BETTER_AUTH_SECRET: VALID.BETTER_AUTH_SECRET,
      NAP_KEY_ENCRYPTION_SECRET: VALID.NAP_KEY_ENCRYPTION_SECRET,
      ...R2,
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
        BETTER_AUTH_SECRET: VALID.BETTER_AUTH_SECRET,
        NAP_KEY_ENCRYPTION_SECRET: VALID.NAP_KEY_ENCRYPTION_SECRET,
        ...R2,
      }),
    ).not.toThrow();
  });

  it("bills OpenRouter unless told otherwise", () => {
    // The route this project uses. Asserted directly rather than left implied by the fixtures,
    // because it decides which credentials boot demands and which account pays for every turn.
    expect(parseEnv(REQUIRED).NAP_PLATFORM).toBe("openrouter");
  });

  it("wants an Anthropic key instead when Anthropic is billed directly", () => {
    // Still a supported route, and the check stays conditional for the same reason it always
    // did: demanding an OpenRouter key from someone paying Anthropic directly is exactly the
    // kind of boot check that teaches people to paste dummy values.
    const anthropic = {
      DATABASE_URL: VALID.DATABASE_URL,
      E2B_API_KEY: VALID.E2B_API_KEY,
      NAP_PLATFORM: "anthropic",
      ANTHROPIC_API_KEY: "sk-ant-test",
      BETTER_AUTH_SECRET: VALID.BETTER_AUTH_SECRET,
      NAP_KEY_ENCRYPTION_SECRET: VALID.NAP_KEY_ENCRYPTION_SECRET,
      ...R2,
    };

    expect(parseEnv(anthropic).NAP_PLATFORM).toBe("anthropic");
  });

  it("refuses to boot on the Anthropic path with no Anthropic key", () => {
    expect(() =>
      parseEnv({ ...REQUIRED, NAP_PLATFORM: "anthropic", OPENROUTER_API_KEY: undefined }),
    ).toThrow(/ANTHROPIC_API_KEY/);
  });

  it("boots with no GitHub app at all, leaving email sign-in as the only way in", () => {
    // The rule this repo states outright: a boot check that demands credentials for something
    // nobody has configured is how people learn to paste dummy values.
    expect(() => parseEnv(REQUIRED)).not.toThrow();
  });

  it.each(["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET"])(
    "refuses %s on its own, since half a GitHub app is not a smaller one",
    (key) => {
      // The alternative failure is a redirect back from GitHub that dies on a blank secret —
      // several steps away from the thing that is actually wrong.
      const other = key === "GITHUB_CLIENT_ID" ? "GITHUB_CLIENT_SECRET" : "GITHUB_CLIENT_ID";

      expect(() => parseEnv({ ...REQUIRED, [key]: "set" })).toThrow(new RegExp(other));
    },
  );

  it("accepts both halves of a GitHub app together", () => {
    expect(() =>
      parseEnv({ ...REQUIRED, GITHUB_CLIENT_ID: "Iv1.test", GITHUB_CLIENT_SECRET: "ghs_test" }),
    ).not.toThrow();
  });

  it.each(["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"])(
    "refuses %s on its own, the same way GitHub's halves are paired",
    (key) => {
      const other = key === "GOOGLE_CLIENT_ID" ? "GOOGLE_CLIENT_SECRET" : "GOOGLE_CLIENT_ID";

      expect(() => parseEnv({ ...REQUIRED, [key]: "set" })).toThrow(new RegExp(other));
    },
  );

  it("accepts both halves of a Google app together", () => {
    expect(() =>
      parseEnv({
        ...REQUIRED,
        GOOGLE_CLIENT_ID: "123.apps.googleusercontent.com",
        GOOGLE_CLIENT_SECRET: "GOCSPX-test",
      }),
    ).not.toThrow();
  });

  it("leaves the demo door open unless it is closed deliberately", () => {
    // A builder nobody can try is a screenshot. What keeps that affordable is the free tier's
    // own ceilings, not a closed door.
    expect(parseEnv(REQUIRED).NAP_ALLOW_DEMO).toBe(true);
    expect(parseEnv({ ...REQUIRED, NAP_ALLOW_DEMO: "false" }).NAP_ALLOW_DEMO).toBe(false);
  });

  it("requires an encryption secret of exactly 32 bytes", () => {
    // A short secret is the realistic mistake — a hand-typed value rather than
    // `openssl rand -base64 32` — and without this it fails at somebody's first save instead
    // of at boot.
    expect(() => parseEnv({ ...REQUIRED, NAP_KEY_ENCRYPTION_SECRET: "too-short" })).toThrow(
      /NAP_KEY_ENCRYPTION_SECRET/,
    );
  });

  it("refuses a free-tier model that is not free", () => {
    // The check that stops the demo door being an open tab on this deployment's account: a
    // paid `NAP_FREE_MODEL` bills every stranger's turns here, visibly only on an invoice.
    expect(() =>
      parseEnv({
        ...REQUIRED,
        NAP_FREE_MODEL: "anthropic/claude-opus-5",
      }),
    ).toThrow(/NAP_FREE_MODEL/);
  });

  it("refuses a free-tier model that is not on the allowlist", () => {
    expect(() => parseEnv({ ...REQUIRED, NAP_FREE_MODEL: "vendor/absent:free" })).toThrow(
      /NAP_FREE_MODEL/,
    );
  });

  it("defaults the free tier tighter than the paying one", () => {
    // Not a coincidence to be preserved by luck: these are the ceilings on what a stranger can
    // spend of *this* deployment's money, and they exist to be lower.
    const env = parseEnv(REQUIRED);

    expect(env.NAP_FREE_TURNS_PER_HOUR).toBeLessThan(env.NAP_TURNS_PER_HOUR);
    expect(env.NAP_FREE_MAX_SANDBOXES_PER_USER).toBeLessThanOrEqual(env.NAP_MAX_SANDBOXES_PER_USER);
    expect(env.NAP_FREE_MODEL.endsWith(":free")).toBe(true);
  });

  it("refuses a free-tier sandbox cap above the machine-wide one", () => {
    expect(() => parseEnv({ ...REQUIRED, NAP_FREE_MAX_SANDBOXES_PER_USER: "99" })).toThrow(
      /NAP_FREE_MAX_SANDBOXES_PER_USER/,
    );
  });

  it("defaults the model to the cheap one", () => {
    // Every message typed into the box spends money. What it spends by default is a decision,
    // and the default is the same model `harness --real` uses.
    const env = parseEnv(REQUIRED);

    expect(env.NAP_MODEL).toBe("openai/gpt-5.6-luna");
    expect(env.NAP_EFFORT).toBe("medium");
  });

  it("takes a different model when one is asked for", () => {
    const env = parseEnv({
      ...REQUIRED,
      NAP_MODEL: "anthropic/claude-opus-5",
      NAP_EFFORT: "xhigh",
    });

    expect(env.NAP_MODEL).toBe("anthropic/claude-opus-5");
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

describe("putting projects away", () => {
  it("defaults to reaping well before a sandbox expires on its own", () => {
    const env = parseEnv(REQUIRED);

    expect(env.NAP_REAP_IDLE_MINUTES).toBe(10);
    expect(env.NAP_SANDBOX_TTL_MINUTES).toBe(30);
    expect(env.NAP_REAP_INTERVAL_SECONDS).toBe(60);
  });

  it("refuses to boot when a sandbox would expire before it is reaped", () => {
    // The whole point of the reaper is that a project is snapshotted before it is destroyed.
    // Configured this way, the provider's timer wins every race and idle projects are simply
    // deleted — with a reaper in the logs cheerfully finding nothing to do.
    expect(() =>
      parseEnv({ ...REQUIRED, NAP_REAP_IDLE_MINUTES: "45", NAP_SANDBOX_TTL_MINUTES: "30" }),
    ).toThrow(/NAP_REAP_IDLE_MINUTES/);
  });

  it("refuses the equal case too, which has the same race", () => {
    expect(() =>
      parseEnv({ ...REQUIRED, NAP_REAP_IDLE_MINUTES: "30", NAP_SANDBOX_TTL_MINUTES: "30" }),
    ).toThrow(/NAP_REAP_IDLE_MINUTES/);
  });

  it("requires somewhere to put the bytes", () => {
    // A server that can destroy sandboxes but not snapshot them is worse than one that does
    // neither, so these become required in the task that first reads them.
    const { R2_BUCKET: _omitted, ...rest } = REQUIRED;

    expect(() => parseEnv(rest)).toThrow(/R2_BUCKET/);
  });
});

describe("what one person may spend", () => {
  it("defaults to limits tight enough to bound a runaway", () => {
    // These are the numbers that decide what a stranger can spend on your behalf, so they are
    // asserted rather than left to whatever the schema happens to say.
    const env = parseEnv(REQUIRED);

    expect(env.NAP_TURNS_PER_HOUR).toBe(15);
    expect(env.NAP_MAX_SANDBOXES_PER_USER).toBe(2);
    expect(env.NAP_MAX_SANDBOXES_TOTAL).toBe(10);
  });

  it("refuses a per-user cap above the machine-wide one", () => {
    // Configured that way the per-user limit can never be reached: the global check refuses
    // first, and tells the asker the server is busy when the projects filling it are their own.
    expect(() =>
      parseEnv({ ...REQUIRED, NAP_MAX_SANDBOXES_PER_USER: "5", NAP_MAX_SANDBOXES_TOTAL: "3" }),
    ).toThrow(/NAP_MAX_SANDBOXES_PER_USER/);
  });

  it("accepts the two being equal, which is a single-user deployment", () => {
    expect(() =>
      parseEnv({ ...REQUIRED, NAP_MAX_SANDBOXES_PER_USER: "3", NAP_MAX_SANDBOXES_TOTAL: "3" }),
    ).not.toThrow();
  });

  it("rejects a zero or negative limit rather than silently blocking every turn", () => {
    // `0` reads like "no limit" and means the opposite: every turn refused, with a message
    // about rate limiting that nobody could act on.
    expect(() => parseEnv({ ...REQUIRED, NAP_TURNS_PER_HOUR: "0" })).toThrow(/NAP_TURNS_PER_HOUR/);
    expect(() => parseEnv({ ...REQUIRED, NAP_MAX_SANDBOXES_PER_USER: "-1" })).toThrow(
      /NAP_MAX_SANDBOXES_PER_USER/,
    );
  });
});

describe("NAP_ALLOWED_MODELS", () => {
  it("defaults to a list spanning the three prices a turn can have", () => {
    // The picker exists to choose between them, and the choice that matters is what a turn
    // costs — so the default has to reach all three tiers. A default of one model would make
    // it a menu with a single row, with everything else reachable only by editing `.env`.
    expect(parseEnv(VALID).NAP_ALLOWED_MODELS).toEqual([
      "openai/gpt-5.6-luna",
      "openai/gpt-5.6-terra",
      "openai/gpt-5.6-sol",
      "anthropic/claude-sonnet-5",
      "anthropic/claude-opus-5",
      "openai/gpt-oss-20b:free",
      "nvidia/nemotron-3-super-120b-a12b:free",
      "google/gemma-4-31b-it:free",
    ]);
  });

  it("starts the default the model every turn falls back to", () => {
    // The boot check below refuses a default that is not allowed, so this is not about
    // reachability — it is that the cheapest model should be the one a fresh checkout runs on.
    const allowed = parseEnv(VALID).NAP_ALLOWED_MODELS;

    expect(allowed[0]).toBe(parseEnv(VALID).NAP_MODEL);
  });

  it("offers models that cost nothing, since trying the thing should not need a balance", () => {
    expect(parseEnv(VALID).NAP_ALLOWED_MODELS.filter((id) => id.endsWith(":free"))).toHaveLength(3);
  });

  it("splits a list and forgives the spaces people type after commas", () => {
    const env = parseEnv({
      ...VALID,
      NAP_MODEL: "a/one",
      NAP_FREE_MODEL: "c/three:free",
      NAP_ALLOWED_MODELS: "a/one, b/two ,c/three:free",
    });

    expect(env.NAP_ALLOWED_MODELS).toEqual(["a/one", "b/two", "c/three:free"]);
  });

  it("refuses to boot when the default is not one of the allowed models", () => {
    // Otherwise every turn that names no model — which is all of them, by default — is refused
    // by the allowlist meant to protect it: a server that starts cleanly and answers nothing.
    expect(() =>
      parseEnv({
        ...VALID,
        NAP_MODEL: "a/one",
        NAP_FREE_MODEL: "b/two:free",
        NAP_ALLOWED_MODELS: "b/two:free",
      }),
    ).toThrow(/NAP_ALLOWED_MODELS/);
  });

  it("refuses an empty list rather than allowing everything", () => {
    expect(() => parseEnv({ ...VALID, NAP_ALLOWED_MODELS: " , " })).toThrow(/NAP_ALLOWED_MODELS/);
  });
});
