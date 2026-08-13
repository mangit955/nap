"use client";

/**
 * Sends the prompt someone typed on the front page, once, as this project's first turn.
 *
 * "Once" is the whole difficulty. The effect that does it re-runs whenever the session
 * resolves, and React mounts the tree twice in development — and each extra run would be a
 * message the user did not write and a turn they did not ask to pay for.
 *
 * **The removal is the guard.** `takeFirstPrompt` deletes what it returns, so a second run
 * finds nothing and there is no separate flag to keep in step with it. A ref saying "already
 * sent" was written here first and removing it broke no test, which is the argument against
 * it: effects run one at a time, so there is no window in which two of them read before either
 * has written.
 *
 * It waits for the session id: a project's conversation is resolved from the server a moment
 * after the page opens, and there is nowhere to send a turn until it arrives.
 */

import { useEffect, useRef } from "react";
import { takeFirstPrompt } from "./first-prompt.ts";

export function useFirstPrompt(options: {
  projectId: string | undefined;
  sessionId: string | undefined;
  submit: (message: string, model?: string) => void;
}): void {
  const { projectId, sessionId, submit } = options;

  // In a ref so a fresh `submit` identity on each render does not re-run the effect. With the
  // stash already taken that run would do nothing anyway — but "nothing, repeatedly" is how a
  // dependency array stops meaning what it says.
  const submitRef = useRef(submit);
  submitRef.current = submit;

  useEffect(() => {
    if (projectId === undefined || sessionId === undefined) return;

    const prompt = takeFirstPrompt(projectId);
    if (prompt === undefined) return;

    submitRef.current(prompt.text, prompt.model);
  }, [projectId, sessionId]);
}
