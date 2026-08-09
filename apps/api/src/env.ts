/**
 * Environment validation, run once at boot.
 *
 * A misconfigured process should die immediately with a message naming everything that is
 * wrong — not start successfully and fail hours later on the first request that happens to
 * need a variable. Zod collects every issue in one pass, which is what makes the "list all
 * missing keys" behaviour fall out naturally rather than needing to be assembled by hand.
 *
 * `parseEnv` takes a record instead of reading `process.env` itself, so it is testable
 * without mutating global state, and so boot order never depends on import order. Only
 * `index.ts` hands it the real environment.
 *
 * Only keys the API reads *today* are required. Credentials for services no code touches yet
 * become required in the task that first reads them — a fail-fast check that fails on things
 * you do not actually need trains people to fill it with dummy values.
 */

import { z } from "zod";

const BaseSchema = z.object({
  DATABASE_URL: z.string().min(1),
  /**
   * The server creates sandboxes itself now that turns run here, so this is required rather
   * than listed as coming later: a process without it fails on the first message someone
   * sends, which is a much worse place to find out than at startup.
   */
  E2B_API_KEY: z.string().min(1),
  /**
   * Which account pays for the model. Not a vendor choice — both routes serve the same Claude
   * models over the same API, and nothing above `LLMProvider` can tell them apart. Which
   * credentials are required depends on this, which is why the check below is conditional
   * rather than a flat list: demanding an Anthropic key from someone billing through AWS is
   * how a boot check teaches people to paste dummy values.
   */
  NAP_PLATFORM: z.enum(["anthropic", "bedrock"]).default("anthropic"),
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  /** Bedrock takes an API key as a bearer token, and throws at construction with no region. */
  AWS_BEARER_TOKEN_BEDROCK: z.string().min(1).optional(),
  AWS_REGION: z.string().min(1).optional(),
  /** Environments are all strings; the rest of the app should not have to remember that. */
  PORT: z.coerce.number().int().positive().default(3001),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

  /**
   * What a turn is allowed to spend, and on what.
   *
   * Every message typed into the chat box is a real model call and a real sandbox, so the
   * default is the cheap one — the same model `bun run harness --real` defaults to. Recording
   * a demo means setting `NAP_MODEL=claude-opus-5` and `NAP_EFFORT=xhigh` for that run, which
   * is one line rather than a code change.
   */
  NAP_MODEL: z.string().min(1).default("claude-sonnet-5"),
  NAP_EFFORT: z.enum(["low", "medium", "high", "xhigh", "max"]).default("medium"),
  /** Model calls in one turn, and the ceiling on the context assembled for each of them. */
  NAP_MAX_STEPS: z.coerce.number().int().positive().default(24),
  NAP_CONTEXT_BUDGET_TOKENS: z.coerce.number().int().positive().default(80_000),
});

/**
 * The credentials the chosen platform needs, and only those.
 *
 * A `superRefine` rather than two schemas, so one parse still reports every problem at once —
 * which is the whole reason this file validates the way it does.
 */
export const EnvSchema = BaseSchema.superRefine((env, ctx) => {
  const required =
    env.NAP_PLATFORM === "bedrock"
      ? (["AWS_BEARER_TOKEN_BEDROCK", "AWS_REGION"] as const)
      : (["ANTHROPIC_API_KEY"] as const);

  for (const key of required) {
    if (env[key] !== undefined) continue;
    ctx.addIssue({
      code: "custom",
      path: [key],
      message: `is required when NAP_PLATFORM is ${env.NAP_PLATFORM}`,
    });
  }
});

export type Env = z.infer<typeof EnvSchema>;

/** Thrown when the environment is unusable. Not a typed result — there is no recovering. */
export class EnvValidationError extends Error {
  constructor(readonly issues: string[]) {
    super(
      `Invalid environment:\n${issues.map((i) => `  - ${i}`).join("\n")}\n\n` +
        "See apps/api/.env.example for the full list.",
    );
    this.name = "EnvValidationError";
  }
}

export function parseEnv(source: Record<string, string | undefined>): Env {
  const result = EnvSchema.safeParse(source);
  if (result.success) return result.data;

  // One line per problem, each naming its key, so a single run tells you everything to fix.
  const issues = result.error.issues.map((issue) => {
    const key = issue.path.join(".") || "(root)";
    return `${key}: ${issue.message}`;
  });
  throw new EnvValidationError(issues);
}
