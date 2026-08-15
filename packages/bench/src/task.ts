/**
 * What a benchmark task is, and the gate every task passes through before anything runs.
 *
 * Tasks are the fixed point of the benchmark — the model, prompt and context engine are the
 * variables — so a task is declarative and says nothing about how Nap is built. See
 * `CONTEXT.md` for the vocabulary.
 *
 * **Validated at load, before a sandbox exists.** A task is a hand-written module, and the
 * failure it invites is a typo in a field name: silently ignored, that produces a run which
 * looks complete and quietly measured something else. Creating a sandbox and calling a model
 * before discovering it would also make the mistake expensive. Hence a strict schema, and
 * hence `parseBenchTask` returning a typed failure rather than throwing — the caller is a CLI
 * that must print the problem, not a stack trace.
 *
 * Deliberately narrow for now: one prompt, and command checks only. Weights, categories,
 * required flags, seeded files and browser checks are all part of the design — see the
 * vocabulary in CONTEXT.md and the weighting rule in docs/adr/0002 — and none of them exist
 * yet. The strict schema is what stops a task file claiming any of them before they do.
 */

import type { Result } from "@nap/shared/result";
import { z } from "zod";
import { AccessibilityCheckSchema } from "./accessibility-check.ts";
import { BrowserCheckSchema } from "./browser-check.ts";
import { type Category, CategorySchema, DEFAULT_CATEGORY_FOR_KIND } from "./category.ts";
import { describeParseFailure } from "./parse-failure.ts";

/**
 * A command run inside the sandbox, judged on its exit code.
 *
 * The kind is a single-member enum rather than an omitted field because the other three kinds
 * are coming, and a task written today should read the same after they arrive.
 */
export const CommandCheckSchema = z.strictObject({
  id: z.string().min(1),
  kind: z.literal("command"),
  command: z.string().min(1),
  /**
   * Which axis this scores into. Absent means the default for the kind — and overriding it is
   * the ordinary case rather than the exception, because `bun run build` and `bun run lint`
   * are both commands and only the first is functional.
   */
  category: CategorySchema.optional(),
  /** Worth relative to the other checks in the same category. Defaults to 1. */
  weight: z.number().nonnegative().optional(),
  /** Whether failing it fails the run outright, whatever the score came to. Defaults to false. */
  required: z.boolean().optional(),
  /**
   * Whether this is the check that decides the application compiles at all.
   *
   * Separate from `required` because it does something extra: a failing build fails the run
   * *and* caps the overall score, since an application that does not compile cannot be
   * three-quarters good however well it lints. Declared by the task rather than sniffed out
   * of the command string, which would make the gate depend on somebody writing "build".
   */
  build: z.boolean().optional(),
});

/**
 * Either kind of check a task may declare.
 *
 * Discriminated on `kind`, which is why every check carried one even when the schema here had
 * a single possible value: a task file written before browser checks existed reads identically
 * after them.
 */
export const BenchCheckSchema = z.discriminatedUnion("kind", [
  CommandCheckSchema,
  BrowserCheckSchema,
  AccessibilityCheckSchema,
]);

/**
 * One file put into the project before the agent sees it.
 *
 * The path is relative to the project root and constrained to stay there. A task file is source
 * code rather than untrusted input, so this is a typo guard rather than a security boundary — but
 * a seeded path of `/etc/hosts` or `../../elsewhere` would write somewhere that is not the
 * application, and the run would then measure an agent against a starting state nobody declared.
 */
export const SeededFileSchema = z.strictObject({
  path: z
    .string()
    .min(1)
    .refine((path) => !path.startsWith("/"), {
      message: "must be relative to the project root, not absolute",
    })
    .refine((path) => !path.split("/").includes(".."), {
      message: "must not climb out of the project root",
    }),
  /** Empty is legitimate: a blank file is a starting state a task may want. */
  contents: z.string(),
});

export type SeededFile = z.infer<typeof SeededFileSchema>;

export const BenchTaskSchema = z
  .strictObject({
    id: z.string().min(1),
    name: z.string().min(1),
    /**
     * What is put to the agent, in order — one turn each.
     *
     * A list rather than a string because a follow-up is the only way to ask the question this
     * benchmark most wants answered: does the agent break what it already built? A task whose
     * second prompt adds a filter, and whose checks still assert the original CRUD behaviour,
     * catches a regression that no single-prompt task could express.
     *
     * Every prompt is one turn, sent only if the one before it completed — see `runner.ts`.
     */
    prompts: z.array(z.string().trim().min(1)).min(1),
    /**
     * The state the sandbox is put into before the agent is asked anything.
     *
     * Absent for the ordinary task, which starts from the template like any new project. Present
     * for "debug this" and "modify this", where the thing being measured is what the agent does
     * to code it did not write — and where the starting state has to be identical every run or
     * the task is not reproducible.
     */
    environment: z
      .strictObject({
        /**
         * Files written into the project before the first prompt.
         *
         * Paths are **relative to the project root** and the runner joins them, so a task never
         * has to know where in a sandbox the project lives — and cannot write outside it.
         */
        files: z.array(SeededFileSchema).min(1),
      })
      .optional(),
    /**
     * The application this task expects to be running, when it expects one.
     *
     * Declared rather than assumed: a task that only asks for a build has no dev server to
     * wait for, and waiting anyway would turn every one of them into a several-minute run
     * that fails on a preview nobody asked about. The port is stated here rather than taken
     * from the sandbox template because the pure package may not depend on it — see
     * docs/adr/0001.
     */
    preview: z
      .strictObject({
        port: z.number().int().positive(),
        /** How long to give the dev server to come up. Absent leaves it to the adapter. */
        timeoutMs: z.number().int().positive().optional(),
      })
      .optional(),
    /** At least one: a task with nothing to check could never produce a score. */
    checks: z.array(BenchCheckSchema).min(1),
  })
  // `superRefine` rather than `refine`, because the messages have to name what is wrong and
  // only this form is handed the parsed value to build them from.
  .superRefine((task, ctx) => {
    const duplicates = duplicateIds(task.checks.map((check) => check.id));
    if (duplicates.length > 0) {
      ctx.addIssue({
        code: "custom",
        // Named rather than counted: the point of the message is to find the duplicate.
        message: `checks must have unique ids — duplicated: ${duplicates.join(", ")}`,
        path: ["checks"],
      });
    }

    // Two files claiming one path is a task whose starting state depends on the order the
    // runner happens to write them in, which is the opposite of the reproducibility seeding
    // exists for. Only one of them could ever survive, and nobody could say which.
    const collisions = duplicateIds((task.environment?.files ?? []).map((file) => file.path));
    if (collisions.length > 0) {
      ctx.addIssue({
        code: "custom",
        message: `seeded files must have unique paths — duplicated: ${collisions.join(", ")}`,
        path: ["environment", "files"],
      });
    }

    // A browser check drives the running application, so a task with one and no preview
    // declares checks that could never be answered. Caught here, as the module loads, rather
    // than as an unexplained pile of failures after a paid run.
    if (task.preview === undefined && task.checks.some((check) => check.kind === "browser")) {
      ctx.addIssue({
        code: "custom",
        message: "a task with browser checks must declare a preview for them to be run against",
        path: ["preview"],
      });
    }
  });

export type CommandCheck = z.infer<typeof CommandCheckSchema>;
export type BenchCheck = z.infer<typeof BenchCheckSchema>;
export type BenchTask = z.infer<typeof BenchTaskSchema>;

function duplicateIds(ids: string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();

  for (const id of ids) {
    if (seen.has(id)) duplicates.add(id);
    seen.add(id);
  }

  return [...duplicates];
}

/** The category a check scores into: what it asked for, or the default for its kind. */
export function categoryOf(check: BenchCheck): Category {
  return check.category ?? DEFAULT_CATEGORY_FOR_KIND[check.kind];
}

/** A check's weight, defaulted. Zero is a legitimate choice and is left alone. */
export function weightOf(check: BenchCheck): number {
  return check.weight ?? 1;
}

/**
 * The two gate flags, defaulted, so nothing downstream has to remember that absent is false.
 *
 * Only a command can be the build: the build gate is about whether the application compiles,
 * and a browser check needs it to have compiled before it can run at all.
 */
export function flagsOf(check: BenchCheck): { required: boolean; build: boolean } {
  return {
    required: check.required ?? false,
    build: check.kind === "command" ? (check.build ?? false) : false,
  };
}

/**
 * Declares a task in a module, validating it as that module loads.
 *
 * **Throws**, unlike `parseBenchTask`, and the difference is who made the mistake: a task
 * file is source code, so a malformed one is a bug rather than an outcome to hand back. It
 * fails at import — before a run id exists, before a sandbox is created, before a model is
 * called — which is the earliest moment it can, and the cheapest.
 */
export function defineTask(task: BenchTask): BenchTask {
  const parsed = parseBenchTask(task);
  if (!parsed.ok) throw new Error(`invalid task: ${parsed.error}`);
  return parsed.value;
}

/** Parses a task, or explains what is wrong with it in a sentence a CLI can print. */
export function parseBenchTask(input: unknown): Result<BenchTask, string> {
  const parsed = BenchTaskSchema.safeParse(input);
  if (parsed.success) return { ok: true, value: parsed.data };

  return { ok: false, error: describeParseFailure(parsed.error, "task") };
}
