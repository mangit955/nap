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
