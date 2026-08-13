/**
 * What every failure in this app says, in one place.
 *
 * Three surfaces can go wrong — the transcript, the preview pane, the box you type into — and
 * left to themselves each grows its own vocabulary for the same event. One turn failing would be
 * "sandbox unavailable" in the chat, "The sandbox didn't start" in the preview and a red line by
 * the input, which reads as three problems rather than one.
 *
 * **Every entry names a recovery, and the recoveries differ on purpose.** That is the whole
 * point: "try again" is right for a sandbox that failed to come up and actively wrong for a turn
 * that ran out of budget, where an identical retry spends the whole allowance again and stops in
 * the same place. A model that declined needs a rephrase, not a retry of the words it declined.
 *
 * **The server's own sentence is kept as `detail` rather than replaced.** It is the part that
 * distinguishes this failure from the next one, and the rate limiter in particular already writes
 * a better sentence than anything that could be reconstructed here from a status code.
 *
 * Keyed as a `Record` over the reason union, so another failure reason added in `@nap/shared`
 * fails typecheck here rather than rendering an empty box.
 */

import type { NapEventOf } from "@nap/shared/events";

type TurnFailureReason = NapEventOf<"turn.failed">["payload"]["reason"];

/**
 * What the user should do next.
 *
 * `none` is a real answer, not a gap: a turn the user cancelled needs no recovery, and offering
 * one would imply something went wrong when nothing did.
 */
export type Recovery =
  | "retry"
  | "rephrase"
  | "wait"
  | "close-project"
  | "sign-in"
  /** Paste an API key. The only recovery that unlocks something rather than undoing it. */
  | "add-key"
  | "none";

export type FailureCopy = {
  /** A short sentence naming what failed, in the user's vocabulary rather than the system's. */
  title: string;
  /** The specific part — usually what the server said. Never empty. */
  detail: string;
  recovery: Recovery;
  /** What the recovery is, in words, whether or not a control is offered alongside it. */
  action: string;
};

/** Shown when the server said nothing useful, so `detail` is never blank. */
const NO_DETAIL: Record<TurnFailureReason, string> = {
  sandbox_unavailable: "The workspace did not report a reason.",
  model_unavailable: "The provider didn't say for how long.",
  internal: "The server did not report a reason.",
  refusal: "The model gave no reason.",
  budget_exceeded: "The turn used its whole allowance of steps.",
  cancelled: "You stopped it.",
};

const TURN_COPY: Record<TurnFailureReason, Omit<FailureCopy, "detail">> = {
  sandbox_unavailable: {
    title: "The workspace couldn't start.",
    recovery: "retry",
    action: "Send the message again — a new workspace is created from your last saved state.",
  },
  model_unavailable: {
    title: "The model is busy right now.",
    // `retry` rather than `wait`, unlike this API's own rate limiter below. There the message
    // is still sitting in the composer and the person re-sends it themselves; here it is
    // already in the transcript, and `retry` is what puts a button under it that sends the
    // same words again. The waiting is said in the action instead.
    recovery: "retry",
    action: "Give it a few seconds, then send the message again.",
  },
  internal: {
    title: "The agent stopped partway through.",
    recovery: "retry",
    // Worth saying: a failed turn commits nothing, so a retry starts from the same place rather
    // than on top of a half-finished edit.
    action: "Send the message again. Nothing was saved, so this starts from where you were.",
  },
  refusal: {
    title: "The model declined this request.",
    recovery: "rephrase",
    action: "Try describing it a different way, or ask for something narrower.",
  },
  budget_exceeded: {
    title: "The turn ran out of room before finishing.",
    recovery: "rephrase",
    // Deliberately not a retry: the same request would spend the same budget and stop in the
    // same place, which is the least useful thing this could suggest.
    action: "Ask for a smaller piece of it — one screen or one feature at a time.",
  },
  cancelled: {
    title: "You stopped this turn.",
    recovery: "none",
    action: "Send another message whenever you're ready.",
  },
};

export function turnFailureCopy(reason: TurnFailureReason, message: string): FailureCopy {
  const trimmed = message.trim();

  return { ...TURN_COPY[reason], detail: trimmed === "" ? NO_DETAIL[reason] : trimmed };
}

/**
 * Copy for a request the server refused outright, before any turn existed.
 *
 * Keyed on the `code` the API sends rather than on the status, because 409 already means several
 * things in this API and the code is the part written to be read by a program.
 */
export function requestFailureCopy(
  status: number,
  code: string | undefined,
  message: string,
): FailureCopy {
  const trimmed = message.trim();

  if (code === "rate_limited") {
    return {
      title: "You've sent a lot of messages.",
      // The server computed the wait from a sliding window; nothing here could reconstruct it.
      detail: trimmed === "" ? "The hourly limit has been reached." : trimmed,
      recovery: "wait",
      action: "Your message is still in the box — send it again once the wait is up.",
    };
  }

  if (code === "sandbox_quota_exceeded") {
    return {
      title: "Too many projects are running.",
      detail: trimmed === "" ? "You are at the limit of running projects." : trimmed,
      recovery: "close-project",
      action: "Close one from the project list, then send this again.",
    };
  }

  if (code === "byok_required") {
    return {
      title: "That model needs your own API key.",
      detail: trimmed === "" ? "Free models work without one." : trimmed,
      recovery: "add-key",
      action: "Add a key to use it, or pick a free model and send this again.",
    };
  }

  if (status === 401) {
    return {
      title: "Your session expired.",
      detail: "Sessions end after a while, and this one has.",
      recovery: "sign-in",
      action: "Sign in again to pick up where you left off.",
    };
  }

  return {
    title: "The server didn't accept that message.",
    detail: trimmed === "" ? `The request came back with status ${status}.` : trimmed,
    recovery: "retry",
    action: "Your message is still in the box — send it again.",
  };
}
