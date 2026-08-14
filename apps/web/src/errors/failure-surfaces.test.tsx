/**
 * One render test per failure mode, which is what `docs/PLAN.md` §4 asks for by name:
 * five modes, five tests, zero generic messages.
 *
 * Each asserts two things — the specific sentence, and the recovery. The second is the half that
 * was missing before this task: the app was already fairly good at saying that something broke.
 *
 * Queried by role and accessible name throughout, per this repo's rule, which is also what makes
 * "a recovery action" a real assertion rather than a check that some words appeared.
 */

import type { NapEvent, NapEventType } from "@nap/shared/events";
import type { StoredEvent } from "@nap/shared/ports/event-store";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SignInForm } from "../auth/sign-in-form.tsx";
import { ChatPane } from "../components/chat-pane.tsx";
import { PreviewPane } from "../components/preview-pane.tsx";
import { expiredNotice } from "./expired-session.ts";
import { requestFailureCopy } from "./failure-copy.ts";

const SESSION = "0b7f8f1e-3c2a-4d5b-9e6f-1a2b3c4d5e6f";
const TURN = "7c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f";

let nextSeq = 1;

function ev<T extends NapEventType>(type: T, payload: Extract<NapEvent, { type: T }>["payload"]) {
  return {
    type,
    sessionId: SESSION,
    turnId: TURN,
    seq: nextSeq++,
    createdAt: "2026-08-09T12:00:00.000Z",
    payload,
  } as StoredEvent;
}

type FailureReason = Extract<NapEvent, { type: "turn.failed" }>["payload"]["reason"];

/** A turn that was asked for and then failed the given way. */
function failedTurn(reason: FailureReason, message: string) {
  nextSeq = 1;
  return [
    ev("user.message", { text: "build me a todo list" }),
    ev("turn.started", {}),
    ev("turn.failed", { reason, message }),
  ];
}

describe("1 · sandbox failure", () => {
  it("names the workspace, and offers to send the message again", () => {
    const onRetry = vi.fn();
    render(
      <ChatPane
        events={failedTurn("sandbox_unavailable", "E2B had no capacity")}
        onRetry={onRetry}
      />,
    );

    expect(screen.getByText(/workspace couldn't start/i)).toBeVisible();
    expect(screen.getByText(/E2B had no capacity/)).toBeVisible();

    // The recovery, and that it re-sends the right message rather than an empty string.
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(onRetry).toHaveBeenCalledWith("build me a todo list");
  });
});

describe("2 · agent failure", () => {
  it("offers a retry when the machinery broke", () => {
    const onRetry = vi.fn();
    render(<ChatPane events={failedTurn("internal", "unhandled error")} onRetry={onRetry} />);

    expect(screen.getByText(/agent stopped partway/i)).toBeVisible();
    expect(screen.getByRole("button", { name: /try again/i })).toBeVisible();
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("asks for a rephrase, not a retry, when the model declined", () => {
    // The distinction this mode exists for. Re-sending the words a model refused gets them
    // refused again, so offering the button here would be advice that cannot work.
    render(<ChatPane events={failedTurn("refusal", "")} onRetry={vi.fn()} />);

    expect(screen.getByText(/model declined/i)).toBeVisible();
    expect(screen.getByText(/different way/i)).toBeVisible();
    expect(screen.queryByRole("button", { name: /try again/i })).not.toBeInTheDocument();
  });

  it("asks for something smaller when the turn ran out of room", () => {
    render(
      <ChatPane
        events={failedTurn("budget_exceeded", "step budget exhausted")}
        onRetry={vi.fn()}
      />,
    );

    expect(screen.getByText(/ran out of room/i)).toBeVisible();
    expect(screen.getByText(/smaller piece/i)).toBeVisible();
    expect(screen.queryByRole("button", { name: /try again/i })).not.toBeInTheDocument();
  });
});

describe("3 · preview failure", () => {
  it("says the same thing the transcript says about the same event", () => {
    // Two panes, one `turn.failed`. Before the copy was shared these disagreed, and a single
    // failure read as two separate problems. The pane is handed the phase that event produces —
    // `project-phase.test.ts` holds the mapping — and the assertion is that both reach for the
    // same words.
    render(<PreviewPane phase={{ kind: "failed", message: "no capacity" }} />);

    expect(screen.getByText(/workspace couldn't start/i)).toBeVisible();
    expect(screen.getByText(/no capacity/)).toBeVisible();
    expect(screen.getByText(/send the message again/i)).toBeVisible();
  });
});

describe("4 · rate limit", () => {
  it("tells the reader to wait, with the server's own wait time", () => {
    const copy = requestFailureCopy(429, "rate_limited", "Too many turns. Try again in 4 minutes.");
    render(<ChatPane events={[]} error={`${copy.title} ${copy.detail} ${copy.action}`} />);

    expect(screen.getByRole("alert")).toHaveTextContent(/4 minutes/);
    // The recovery: the message is still in the box, so sending again is the whole action.
    expect(screen.getByRole("alert")).toHaveTextContent(/send it again/i);
  });

  it("tells a quota refusal to close a project instead", () => {
    const copy = requestFailureCopy(409, "sandbox_quota_exceeded", "You already have 2 running.");
    render(<ChatPane events={[]} error={`${copy.title} ${copy.detail} ${copy.action}`} />);

    expect(screen.getByRole("alert")).toHaveTextContent(/close one/i);
  });
});

describe("5 · auth expiry", () => {
  it("explains why the sign-in page appeared, without calling it an error", () => {
    const notice = expiredNotice("1");
    render(
      <SignInForm
        mode="sign-in"
        onModeChange={() => {}}
        onSubmit={() => {}}
        onSocial={() => {}}
        onDemo={() => {}}
        socialProviders={[]}
        demoEnabled={false}
        notice={notice}
      />,
    );

    // A `status`, not an `alert`: the reader did nothing wrong, and the recovery is the form
    // already in front of them.
    expect(screen.getByRole("status")).toHaveTextContent(/session expired/i);
    expect(screen.getByRole("status")).toHaveTextContent(/sign in again/i);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("says nothing when somebody simply navigated here", () => {
    render(
      <SignInForm
        mode="sign-in"
        onModeChange={() => {}}
        onSubmit={() => {}}
        onSocial={() => {}}
        onDemo={() => {}}
        socialProviders={[]}
        demoEnabled={false}
        notice={expiredNotice(undefined)}
      />,
    );

    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
