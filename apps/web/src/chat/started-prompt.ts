import { MediaAttachmentsSchema } from "@nap/shared/media";
import { z } from "zod";
import { defaultStorage, type PromptStorage } from "./first-prompt.ts";

/**
 * The prompt a new project was started with, carried from the dashboard to its workspace so it
 * is on screen the moment the workspace is.
 *
 * **Display only.** By the time this is written the server has already admitted the prompt as
 * the project's first queued request — `POST /sessions/start` answered with its `requestId` —
 * so nothing that reads this may ever send it: doing so would queue the same turn twice. That is
 * the whole difference from `first-prompt.ts`, whose stash is a prompt nobody has sent yet.
 *
 * The workspace hands it to the submission hook as a request already accepted, which retires it
 * by that request's identity — its own `user.message`, or the request ending without one — and
 * never by its text, which another turn can share.
 *
 * Kept in `sessionStorage` for the reasons `first-prompt.ts` gives, and addressed to one project:
 * another project's is left where it is, and one that cannot be read is thrown away.
 */

const KEY = "nap.started-prompt";

const StartedPromptSchema = z.object({
  projectId: z.uuid(),
  sessionId: z.uuid(),
  /** The admitted request, which also names the turn it becomes. */
  requestId: z.uuid(),
  text: z.string().min(1),
  attachments: MediaAttachmentsSchema.optional(),
  /** So the workspace's composer starts on the model the prompt was sent with. */
  model: z.string().min(1).optional(),
});
export type StartedPrompt = z.infer<typeof StartedPromptSchema>;

/**
 * Leaves it for the workspace. Never throws: the project already exists, and a full or disabled
 * storage should cost the early bubble rather than the navigation to it.
 */
export function handOffStartedPrompt(
  started: StartedPrompt,
  storage: PromptStorage | undefined = defaultStorage(),
): void {
  try {
    storage?.setItem(KEY, JSON.stringify(started));
  } catch {
    // The log shows the prompt once it arrives; this was only ever a head start.
  }
}

/** This project's, left where it is — safe to call from a render, which may run twice. */
export function peekStartedPrompt(
  projectId: string,
  storage: PromptStorage | undefined = defaultStorage(),
): StartedPrompt | undefined {
  const raw = read(storage);
  const started = raw === undefined ? undefined : parse(raw);
  return started?.projectId === projectId ? started : undefined;
}

/**
 * This project's, removed, so returning to the workspace later never shows it again. Another
 * project's stays; an unreadable one goes, since nobody will ever want it.
 */
export function takeStartedPrompt(
  projectId: string,
  storage: PromptStorage | undefined = defaultStorage(),
): StartedPrompt | undefined {
  const raw = read(storage);
  if (raw === undefined) return undefined;
  const started = parse(raw);
  if (started !== undefined && started.projectId !== projectId) return undefined;
  try {
    storage?.removeItem(KEY);
  } catch {
    // Nothing to do: a storage that cannot be written to cannot hold it for long either.
  }
  return started;
}

function read(storage: PromptStorage | undefined): string | undefined {
  try {
    return storage?.getItem(KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

function parse(raw: string): StartedPrompt | undefined {
  try {
    const parsed = StartedPromptSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
