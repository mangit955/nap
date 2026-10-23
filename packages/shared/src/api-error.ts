/**
 * What the API answers with when it refuses: a sentence for a person, and sometimes a code for
 * the client.
 *
 * The sentence is shown as it is; the code is what a client branches on, because wording is free
 * to change and a client that matched on it would silently stop recognising a refusal the day
 * somebody improved the copy. Defined here so the side that writes a code and the side that reads
 * it cannot spell it differently.
 */

import { z } from "zod";

export const ApiErrorSchema = z.object({
  error: z.string(),
  code: z.string().optional(),
});

export type ApiError = z.infer<typeof ApiErrorSchema>;

/**
 * A guest asked for something only a permanent account may have. A client answers it with a way
 * to sign in rather than an error, since nothing about retrying would help.
 */
export const SIGN_IN_REQUIRED = "sign_in_required";

export const SignInRequiredSchema = ApiErrorSchema.extend({
  code: z.literal(SIGN_IN_REQUIRED),
});

export type SignInRequired = z.infer<typeof SignInRequiredSchema>;
