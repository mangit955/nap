/**
 * The shapes the agent hands to the person watching rather than to the sandbox.
 *
 * A plan and a question are both things the model writes as tool arguments and the chat pane
 * renders, so the schema the tool validates against is the schema the event carries. Defined
 * once here, below both, so the two can never disagree about what a valid checklist is.
 *
 * The limits are presentation limits, not model limits: a checklist of two hundred items is not
 * a plan anybody can read, and a question with nine options is a form. Refusing them at the tool
 * boundary sends the model back to write something a person can act on.
 */

import { z } from "zod";

export const PlanItemStatusSchema = z.enum(["pending", "in_progress", "completed"]);
export type PlanItemStatus = z.infer<typeof PlanItemStatusSchema>;

export const PlanItemSchema = z.strictObject({
  content: z.string().trim().min(1).max(300).describe("What this step achieves, in a few words"),
  status: PlanItemStatusSchema,
});
export type PlanItem = z.infer<typeof PlanItemSchema>;

/** The whole list, every time: a plan is replaced, never patched, so there is nothing to merge. */
export const PlanSchema = z.array(PlanItemSchema).max(30);

export const QuestionOptionSchema = z.strictObject({
  label: z.string().trim().min(1).max(80).describe("The answer, as the person would click it"),
  /** `null` rather than absent, because the event is stored as jsonb. */
  description: z
    .string()
    .trim()
    .max(300)
    .nullable()
    .describe("What choosing this would mean, or null"),
});
export type QuestionOption = z.infer<typeof QuestionOptionSchema>;

export const QuestionSchema = z.strictObject({
  question: z.string().trim().min(1).max(500),
  options: z.array(QuestionOptionSchema).min(2).max(4),
  multiSelect: z.boolean(),
});
export type Question = z.infer<typeof QuestionSchema>;

/**
 * What a delegated piece of work may do. See ADR-0020.
 *
 * `explore` reads and searches and changes nothing, which is what makes several of them safe to
 * run at once. `general` may also edit files, so it runs alone, like any other write.
 */
export const SubagentProfileSchema = z.enum(["explore", "general"]);
export type SubagentProfile = z.infer<typeof SubagentProfileSchema>;

export const SubagentOutcomeSchema = z.enum(["completed", "failed", "cancelled"]);
export type SubagentOutcome = z.infer<typeof SubagentOutcomeSchema>;

/**
 * A plan proposed for approval, as the agent writes it and as the person reads it.
 *
 * Different from the checklist above, which tracks work in flight and is replaced as it moves. A
 * proposal is prose — what will change, where, and in what order — written before anything has
 * changed, and it is the thing the person says yes or no to (ADR-0025). The title is what the
 * card and the job that carries it out are called; the body is Markdown.
 *
 * The body's ceiling is a reading limit and a prompt limit at once: an approved plan rides in the
 * system prompt of every turn of the job that carries it out, and is never cut to fit.
 */
export const ProposedPlanSchema = z.strictObject({
  title: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .describe("What the plan achieves, in a few words, like a commit subject"),
  plan: z
    .string()
    .trim()
    .min(1)
    .max(12_000)
    .describe(
      "The plan in Markdown: what will change and why, the files involved, and the steps in order",
    ),
});
export type ProposedPlan = z.infer<typeof ProposedPlanSchema>;

/**
 * What a turn does about plans, chosen by whoever sends the prompt. Absent is an ordinary turn.
 *
 * `propose` runs the turn in plan mode: it may read and search, and it ends by proposing a plan
 * instead of changing anything. `approve` names the plan mode turn whose proposal this prompt
 * approves, and runs an ordinary turn with that plan carried into its context. A per-turn fact
 * about who asked, like the model — never a deployment setting.
 */
export const PlanIntentSchema = z.discriminatedUnion("intent", [
  z.strictObject({ intent: z.literal("propose") }),
  z.strictObject({ intent: z.literal("approve"), planTurnId: z.uuid() }),
]);
export type PlanIntent = z.infer<typeof PlanIntentSchema>;
