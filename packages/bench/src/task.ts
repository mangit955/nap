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
import { type Category, CategorySchema, DEFAULT_CATEGORY_FOR_KIND } from "./category.ts";

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
});

export const BenchTaskSchema = z
  .strictObject({
    id: z.string().min(1),
    name: z.string().min(1),
    prompt: z.string().min(1),
    /** At least one: a task with nothing to check could never produce a score. */
    checks: z.array(CommandCheckSchema).min(1),
  })
  // `superRefine` rather than `refine`, because the message has to name the offending id and
  // only this form is handed the parsed value to build it from.
  .superRefine((task, ctx) => {
    const duplicates = duplicateIds(task.checks.map((check) => check.id));
    if (duplicates.length === 0) return;

    ctx.addIssue({
      code: "custom",
      // Named rather than counted: the point of the message is to find the duplicate.
      message: `checks must have unique ids — duplicated: ${duplicates.join(", ")}`,
      path: ["checks"],
    });
  });

export type CommandCheck = z.infer<typeof CommandCheckSchema>;
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
export function categoryOf(check: CommandCheck): Category {
  return check.category ?? DEFAULT_CATEGORY_FOR_KIND[check.kind];
}

/** A check's weight, defaulted. Zero is a legitimate choice and is left alone. */
export function weightOf(check: CommandCheck): number {
  return check.weight ?? 1;
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

  return {
    ok: false,
    error: parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "task"}: ${issue.message}`)
      .join("; "),
  };
}
