/**
 * What the API and the browser say to each other about provider accounts: a Claude or ChatGPT
 * subscription somebody has connected, so their turns can run on the plan they already pay for.
 *
 * Modelled on T3 Code's provider instances, because the experience is meant to be the same one:
 * a person may hold several accounts of one provider ("Personal", "Work"), each signs in on its
 * own, and each can be switched off without being forgotten.
 *
 * **Nothing here ever carries a credential.** The provider's own agent — Claude Code, Codex —
 * owns its login and keeps whatever it stores. What crosses this boundary is whether an account
 * is signed in, and as whom: enough to show a person which account is which, and nothing anybody
 * could replay.
 */

import { z } from "zod";

/** The agents Nap can run on somebody's subscription. */
export const ProviderDriverSchema = z.enum(["claude", "codex"]);
export type ProviderDriver = z.infer<typeof ProviderDriverSchema>;

/** How many accounts one person may connect. A list longer than this is a mistake or abuse. */
export const PROVIDER_ACCOUNT_LIMIT = 8;

/** Shown in the provider list beside the provider's own name, so 40 is what fits on one line. */
export const ProviderAccountLabelSchema = z.string().trim().min(1).max(40);

export const ProviderAuthStatusSchema = z.enum(["unauthenticated", "authenticated", "expired"]);
export type ProviderAuthStatus = z.infer<typeof ProviderAuthStatusSchema>;

export const ProviderAuthSchema = z.object({
  status: ProviderAuthStatusSchema,
  /** As the provider reported it after sign-in. Null until then. */
  email: z.string().nullable(),
  /** The plan name the provider reported — "Claude Pro", "ChatGPT Plus". */
  plan: z.string().nullable(),
});
export type ProviderAuth = z.infer<typeof ProviderAuthSchema>;

export const ProviderAccountSchema = z.object({
  id: z.uuid(),
  driver: ProviderDriverSchema,
  /** Null means "use the provider's own name". */
  label: z.string().nullable(),
  enabled: z.boolean(),
  auth: ProviderAuthSchema,
  createdAt: z.iso.datetime(),
});
export type ProviderAccount = z.infer<typeof ProviderAccountSchema>;

export const CreateProviderAccountSchema = z.object({
  driver: ProviderDriverSchema,
  label: ProviderAccountLabelSchema.optional(),
});
export type CreateProviderAccount = z.infer<typeof CreateProviderAccountSchema>;

export const UpdateProviderAccountSchema = z
  .object({
    label: ProviderAccountLabelSchema.nullable().optional(),
    enabled: z.boolean().optional(),
  })
  .refine((update) => update.label !== undefined || update.enabled !== undefined, {
    message: "Nothing to change.",
  });
export type UpdateProviderAccount = z.infer<typeof UpdateProviderAccountSchema>;

/**
 * What the person has to do next, while a sign-in is running.
 *
 * Claude Code signs in through its own terminal login, so its step is the terminal's output.
 * ChatGPT signs in in a browser tab. The link must be `https`, because it is rendered as one.
 */
export const ProviderSignInInteractionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("browser"), url: z.url({ protocol: /^https$/ }) }),
  z.object({
    type: z.literal("deviceCode"),
    url: z.url({ protocol: /^https$/ }),
    userCode: z.string().min(1),
  }),
  z.object({
    type: z.literal("terminal"),
    output: z.string().max(65_536),
    input: z.literal("code").optional(),
  }),
]);
export type ProviderSignInInteraction = z.infer<typeof ProviderSignInInteractionSchema>;

export const ProviderSignInPhaseSchema = z.enum([
  "starting",
  "waiting",
  "verifying",
  "succeeded",
  "failed",
  "cancelled",
]);
export type ProviderSignInPhase = z.infer<typeof ProviderSignInPhaseSchema>;

/** One sign-in attempt, as T3 Code's provider auth state models it. */
export const ProviderSignInSchema = z.object({
  flowId: z.string().min(1),
  phase: ProviderSignInPhaseSchema,
  interaction: ProviderSignInInteractionSchema.nullable(),
  /** Why it failed, in a sentence for a person. Null otherwise. */
  message: z.string().nullable(),
});
export type ProviderSignIn = z.infer<typeof ProviderSignInSchema>;

/** Browser-owned handoff; the server validates the registered callback and single-use state. */
export const CompleteProviderSignInSchema = z.strictObject({
  flowId: z.uuid(),
  redirect: z.string().min(1).max(16_384),
});
export type CompleteProviderSignIn = z.infer<typeof CompleteProviderSignInSchema>;

/**
 * An account as the settings page shows it: what is stored, and the sign-in running on it now.
 * Folded into one answer so the page polls a single endpoint while somebody is signing in.
 */
export const ProviderAccountViewSchema = ProviderAccountSchema.extend({
  signIn: ProviderSignInSchema.nullable(),
});
export type ProviderAccountView = z.infer<typeof ProviderAccountViewSchema>;

export const ProviderAccountsSchema = z.object({
  /** Only these providers have a configured, supported sign-in implementation. */
  signInDrivers: z.array(ProviderDriverSchema).max(2),
  /** When the statuses below were read, for the page's "Checked …" line. */
  checkedAt: z.iso.datetime(),
  accounts: z.array(ProviderAccountViewSchema),
});
export type ProviderAccounts = z.infer<typeof ProviderAccountsSchema>;

/** The deployment has no runtime to sign in with. A client shows why rather than retrying. */
export const SIGN_IN_UNAVAILABLE = "sign_in_unavailable";

/** This person already has `PROVIDER_ACCOUNT_LIMIT` accounts. */
export const PROVIDER_ACCOUNT_LIMIT_REACHED = "provider_account_limit";
