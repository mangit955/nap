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
   * Which account pays for the model, and therefore which credentials are required — hence the
   * conditional check below rather than a flat list. Demanding an Anthropic key from someone
   * billing through OpenRouter is how a boot check teaches people to paste dummy values.
   *
   * **OpenRouter is the default and the route this project actually uses.** The other two are
   * kept because they are the same Messages API underneath and cost nothing to keep working,
   * but nothing here is configured for them.
   */
  NAP_PLATFORM: z.enum(["openrouter", "anthropic", "bedrock"]).default("openrouter"),
  /** Billed to an OpenRouter account, whatever the model. Keys look like `sk-or-…`. */
  OPENROUTER_API_KEY: z.string().min(1).optional(),
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  /** Bedrock takes an API key as a bearer token, and throws at construction with no region. */
  AWS_BEARER_TOKEN_BEDROCK: z.string().min(1).optional(),
  AWS_REGION: z.string().min(1).optional(),
  /**
   * Signs session cookies. Required from the moment there is sign-in to sign: a process that
   * cannot verify its own cookies has no way to tell who is asking.
   */
  BETTER_AUTH_SECRET: z.string().min(1),
  /**
   * Where the browser app is served from, and the one origin allowed through CORS with
   * credentials. It is a different port from this API in development, so it has to be named —
   * and it cannot be `*`, because a browser will not send a cookie to a wildcard origin.
   */
  NAP_WEB_ORIGIN: z.url().default("http://localhost:3000"),
  /** Where this API is reached. OAuth redirect URIs are built from it, so it must be right. */
  NAP_API_URL: z.url().default("http://localhost:3001"),
  /**
   * A GitHub OAuth app, if there is one. Optional but paired — see the check below. Without
   * them the GitHub button simply is not offered and email sign-in works as usual.
   */
  GITHUB_CLIENT_ID: z.string().min(1).optional(),
  GITHUB_CLIENT_SECRET: z.string().min(1).optional(),
  /** Environments are all strings; the rest of the app should not have to remember that. */
  PORT: z.coerce.number().int().positive().default(3001),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

  /**
   * What a turn is allowed to spend, and on what.
   *
   * Every message typed into the chat box is a real model call and a real sandbox, so the
   * default is the cheap one, and it is the model this project runs everywhere — the harness,
   * the API and the provider's own fallback all name it. Raising the ceiling for something
   * people will watch is `NAP_MODEL` and `NAP_EFFORT` on that run, which is one line rather
   * than a code change.
   *
   * It is priced at roughly a twentieth of a frontier model per token, which is what makes it
   * the one to debug the agent loop against: most turns during development are spent proving
   * event ordering and tool sequencing, and that does not need a good model, only one that
   * returns well-formed tool calls. It is a *fully namespaced* OpenRouter id — a bare name is
   * assumed to be Anthropic's, which is how this codebase has always spelled a model, so a
   * namespace is what keeps the default pointed where it says.
   */
  NAP_MODEL: z.string().min(1).default("openai/gpt-5.6-luna"),
  NAP_EFFORT: z.enum(["low", "medium", "high", "xhigh", "max"]).default("medium"),

  /**
   * Which models a request may ask for, as a comma-separated list.
   *
   * This exists because the turn endpoint accepts a model, and a model id taken from a request
   * body and passed to the provider is a stranger choosing what you pay per token. The
   * allowlist is the whole defence: anything not named here is refused before a sandbox is
   * touched or a single token is spent.
   *
   * The default spans the three prices a turn can have: the cheap OpenAI models the loop is
   * debugged against, the Claude models worth recording a demo on, and free ones for trying the
   * thing at no cost at all.
   *
   * **Every id here was read from OpenRouter's live catalogue and every one supports tool
   * calling.** That second filter is not a nicety — this agent *is* a tool loop, so a model
   * without tools cannot take a single step and every turn on it fails identically. Two thirds
   * of OpenRouter's free models are in that category, which is why the free entries here are a
   * chosen three rather than everything that costs nothing.
   */
  NAP_ALLOWED_MODELS: z
    .string()
    .default(
      [
        // Cheap first, because it is the default and the one most turns should run on.
        "openai/gpt-5.6-luna",
        "openai/gpt-5.6-terra",
        "openai/gpt-5.6-sol",
        "anthropic/claude-sonnet-5",
        "anthropic/claude-opus-5",
        // Free, and therefore the ones to reach for when the point is to try the thing rather
        // than to get a good answer.
        "openai/gpt-oss-20b:free",
        "nvidia/nemotron-3-super-120b-a12b:free",
        "google/gemma-4-31b-it:free",
      ].join(","),
    )
    .transform((list) =>
      list
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry !== ""),
    )
    .refine((models) => models.length > 0, { message: "must name at least one model" }),
  /** Model calls in one turn, and the ceiling on the context assembled for each of them. */
  NAP_MAX_STEPS: z.coerce.number().int().positive().default(24),
  NAP_CONTEXT_BUDGET_TOKENS: z.coerce.number().int().positive().default(80_000),

  /**
   * What one person may spend.
   *
   * Every turn is a real model call and a real sandbox billed by the second, so an endpoint with
   * no ceiling is a bill with no ceiling — reachable by a loop in a browser tab as easily as by
   * anyone malicious. The defaults are deliberately tight: a working session is usually five to
   * ten messages, so fifteen an hour is room to work rather than a wall, and two running
   * projects is more than anybody uses at once.
   *
   * `NAP_MAX_SANDBOXES_TOTAL` is the process-wide ceiling and is the only one of the three that
   * bounds what *everybody together* can spend. Per-user limits alone multiply by the number of
   * users, which is the arithmetic that matters the first time this is shown to strangers.
   */
  NAP_TURNS_PER_HOUR: z.coerce.number().int().positive().default(15),
  NAP_MAX_SANDBOXES_PER_USER: z.coerce.number().int().positive().default(2),
  NAP_MAX_SANDBOXES_TOTAL: z.coerce.number().int().positive().default(10),

  /**
   * Where a project's bytes live while no sandbox is holding them.
   *
   * Required from the moment the server can put a project away and take it out again: a
   * process without a bucket destroys sandboxes it cannot snapshot, which is the one failure
   * mode this whole area exists to prevent.
   */
  R2_ACCOUNT_ID: z.string().min(1),
  R2_BUCKET: z.string().min(1),
  R2_ACCESS_KEY_ID: z.string().min(1),
  R2_SECRET_ACCESS_KEY: z.string().min(1),

  /**
   * When an unused project is put away, and how long its sandbox lives in the meantime.
   *
   * **The idle threshold must stay well below the sandbox lifetime.** Whichever expires first
   * decides what happens to an idle project: the reaper snapshots it before destroying it, and
   * the provider's own timer simply deletes it. There is a boot check below for that.
   */
  NAP_REAP_IDLE_MINUTES: z.coerce.number().int().positive().default(10),
  NAP_REAP_INTERVAL_SECONDS: z.coerce.number().int().positive().default(60),
  NAP_SANDBOX_TTL_MINUTES: z.coerce.number().int().positive().default(30),

  /**
   * A Chrome or Chromium binary to photograph finished turns with, for the dashboard's cards.
   *
   * Optional, and the one env key here that is genuinely allowed to be absent: without it the
   * API runs exactly as before and the dashboard draws a colour where a screenshot would be.
   * Nothing goes looking for a browser — a capture that silently found *some* binary is worse
   * than one that says it has none.
   */
  NAP_CHROME_PATH: z.string().min(1).optional(),
});

/**
 * The credentials the chosen platform needs, and only those.
 *
 * A `superRefine` rather than two schemas, so one parse still reports every problem at once —
 * which is the whole reason this file validates the way it does.
 */
export const EnvSchema = BaseSchema.superRefine((env, ctx) => {
  const required =
    env.NAP_PLATFORM === "openrouter"
      ? (["OPENROUTER_API_KEY"] as const)
      : env.NAP_PLATFORM === "bedrock"
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

  // Half a GitHub app is not a smaller GitHub app. Configured with only one of the two, the
  // provider would either be silently skipped — a button that vanished for no stated reason —
  // or registered with a blank secret, which fails at the redirect back from GitHub, several
  // steps away from the thing that is actually wrong.
  const github = [
    ["GITHUB_CLIENT_ID", env.GITHUB_CLIENT_ID],
    ["GITHUB_CLIENT_SECRET", env.GITHUB_CLIENT_SECRET],
  ] as const;
  const supplied = github.filter(([, value]) => value !== undefined);

  if (supplied.length === 1) {
    for (const [key, value] of github) {
      if (value !== undefined) continue;
      ctx.addIssue({
        code: "custom",
        path: [key],
        message: "is required when the other GITHUB_CLIENT_* variable is set",
      });
    }
  }

  // The default has to be reachable, or every turn that names no model is refused by the
  // allowlist that was meant to protect it — a server that boots fine and answers nothing.
  if (!env.NAP_ALLOWED_MODELS.includes(env.NAP_MODEL)) {
    ctx.addIssue({
      code: "custom",
      path: ["NAP_ALLOWED_MODELS"],
      message: `must include NAP_MODEL (${env.NAP_MODEL})`,
    });
  }

  // A per-user cap above the machine-wide one is unreachable: the global check would refuse
  // first, and the message would talk about the server being busy when the projects filling it
  // are the asker's own. Loud here rather than confusing at request time.
  if (env.NAP_MAX_SANDBOXES_PER_USER > env.NAP_MAX_SANDBOXES_TOTAL) {
    ctx.addIssue({
      code: "custom",
      path: ["NAP_MAX_SANDBOXES_PER_USER"],
      message: `must not exceed NAP_MAX_SANDBOXES_TOTAL (${env.NAP_MAX_SANDBOXES_TOTAL}), or the per-user limit can never be reached`,
    });
  }

  // A configuration that reaps later than the provider kills is worse than no reaper at all:
  // every idle project would be deleted without a snapshot, silently, and the logs would show
  // a reaper finding nothing to do.
  if (env.NAP_REAP_IDLE_MINUTES >= env.NAP_SANDBOX_TTL_MINUTES) {
    ctx.addIssue({
      code: "custom",
      path: ["NAP_REAP_IDLE_MINUTES"],
      message: `must be less than NAP_SANDBOX_TTL_MINUTES (${env.NAP_SANDBOX_TTL_MINUTES}), or sandboxes expire before they are snapshotted`,
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
