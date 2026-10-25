import type { NativePromptInput } from "@nap/shared/ports/agent-service";
import type { JobContext } from "@nap/shared/ports/context-engine";
import { renderJobBrief } from "./job-brief.ts";
import { REPOSITORY_SYSTEM_PROMPT, SYSTEM_PROMPT } from "./system-prompt.ts";

/** Native agents retain their own transcript; only the new request and repair facts are sent. */
export function buildNativePrompt(input: {
  prompt: string;
  workspace?: "repository" | undefined;
  job?: JobContext | undefined;
  attachments?: NativePromptInput["attachments"];
}): NativePromptInput {
  const brief =
    input.job === undefined ||
    (input.job.attempts.length === 0 && input.job.objective === input.prompt.trim())
      ? ""
      : renderJobBrief(input.job);
  return {
    trustedInstructions:
      input.workspace === "repository" ? REPOSITORY_SYSTEM_PROMPT : SYSTEM_PROMPT,
    prompt: brief === "" ? input.prompt : `${input.prompt}\n\nQuoted job context:\n${brief}`,
    ...(input.attachments === undefined ? {} : { attachments: input.attachments }),
  };
}
