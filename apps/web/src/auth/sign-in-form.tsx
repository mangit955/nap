/**
 * The way in: an email and a password, or GitHub.
 *
 * Pure, like every other renderer in this app — `LiveSignIn` owns the requests and the
 * redirect. What that split buys here is that the interesting states (a wrong password, a
 * submission in flight, no GitHub app configured) are all one prop away in a test, with no
 * network and no router.
 *
 * **One form, two modes.** Signing up and signing in differ by a name field and a verb, and
 * two pages would mean two of everything for that. The mode is a link, not a tab, because
 * there are exactly two and a person arrives wanting one of them.
 *
 * **It stands on the same stage as the front page.** `.ai-stage` carries the neutral surface and
 * the whole light token ramp, so this file names no colours of its own beyond the tokens it
 * inherits. It used to be drawn in the dark workspace palette, which meant pressing Sign up on a
 * pale, typographic page and landing on something that looked like a different product — on the
 * one screen standing between a visitor and an account.
 *
 * Errors are words in the same place every time, in a live region: what comes back from a
 * failed sign-in is the only thing on this screen anybody needs to read, and a message that
 * changes only visually is one a screen reader never mentions.
 */

import { useState } from "react";
import { NapMark } from "../brand/nap-mark.tsx";

export type SignInMode = "sign-in" | "sign-up";

export type SignInFormProps = {
  mode: SignInMode;
  onModeChange: (mode: SignInMode) => void;
  onSubmit: (credentials: { email: string; password: string; name: string }) => void;
  onGithub: () => void;
  /** Offered only when the API has a GitHub app; see `/auth/providers`. */
  githubEnabled: boolean;
  /** In words, for the person who just tried. Undefined when nothing has gone wrong. */
  error?: string | undefined;
  /**
   * Why they are here, when they did not choose to be — an expired session, arriving from a
   * redirect. Distinct from `error`: nothing they did was wrong, and drawing it in the same red
   * as a bad password would say otherwise.
   */
  notice?: string | undefined;
  submitting?: boolean;
};

/**
 * What each half of the form says about itself. The emphasis word is set heavy and near-black
 * against a light sentence, which is the landing page's treatment at a smaller size — the page
 * a person just came from and the page they arrive on should be recognisably the same voice.
 */
const COPY: Record<SignInMode, { lead: string; emphasis: string; sub: string }> = {
  "sign-in": {
    lead: "Welcome",
    emphasis: "back.",
    sub: "Your apps are where you left them.",
  },
  "sign-up": {
    lead: "Start a",
    emphasis: "nap.",
    sub: "Describe an app; we'll build it while you're gone.",
  },
};

/*
 * 16px on the input is not a style choice: below it, iOS zooms the page in on focus and does not
 * zoom back out, which leaves somebody halfway through signing up looking at a form twice the
 * width of their screen.
 */
const FIELD =
  "w-full rounded-[10px] border border-[var(--s-border-1)] bg-[var(--s-surface-1)] px-3.5 py-2.5 " +
  "text-[16px] text-[var(--s-text-primary)] outline-none placeholder:text-[var(--s-text-subtle)] " +
  "focus-visible:border-[var(--s-text-subtle)] focus-visible:outline focus-visible:outline-2 " +
  "focus-visible:outline-[var(--s-text-primary)] focus-visible:outline-offset-1";

const PILL =
  "rounded-full px-5 py-2.5 font-medium text-sm transition-opacity focus-visible:outline " +
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--s-text-primary)] " +
  "disabled:opacity-50";

export function SignInForm({
  mode,
  onModeChange,
  onSubmit,
  onGithub,
  githubEnabled,
  error,
  notice,
  submitting = false,
}: SignInFormProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");

  const signingUp = mode === "sign-up";
  const verb = signingUp ? "Create account" : "Sign in";
  const copy = COPY[mode];

  return (
    <div className="ai-stage relative flex min-h-dvh flex-col items-center justify-center px-6 py-20">
      {/*
        The mark is the way back out. An auth page with no exit is a dead end for anybody who
        arrived by accident, and the wordmark is the one thing on it people already know is a
        link everywhere else.
      */}
      <a
        href="/"
        aria-label="nap, back to the front page"
        className="absolute top-4 left-6 flex items-center gap-0.5 font-semibold text-[var(--s-text-primary)] text-sm tracking-tight focus-visible:outline focus-visible:outline-1 focus-visible:outline-[var(--s-text-primary)]"
      >
        <NapMark className="size-10" />
        nap
      </a>

      <main className="flex w-full max-w-sm flex-col">
        <h1 className="text-center font-display font-extralight text-[var(--s-text-body)] text-3xl tracking-[-0.03em]">
          {copy.lead}{" "}
          <span className="font-semibold text-[var(--s-text-primary)]">{copy.emphasis}</span>
        </h1>
        <p className="mt-2.5 text-balance text-center text-[var(--s-text-muted)] text-sm">
          {copy.sub}
        </p>

        <div className="mt-8 rounded-[20px] border border-[var(--s-border-1)] bg-[var(--s-surface-1)] p-6 shadow-[0_1px_2px_rgba(12,38,77,0.06),0_10px_30px_-12px_rgba(12,38,77,0.18)]">
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              onSubmit({ email, password, name });
            }}
          >
            {signingUp && (
              <label className="flex flex-col gap-1.5">
                <span className="font-medium text-[var(--s-text-body)] text-xs">Name</span>
                <input
                  type="text"
                  required
                  autoComplete="name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  className={FIELD}
                />
              </label>
            )}

            <label className="flex flex-col gap-1.5">
              <span className="font-medium text-[var(--s-text-body)] text-xs">Email</span>
              <input
                type="email"
                required
                autoComplete="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                className={FIELD}
              />
            </label>

            <label className="flex flex-col gap-1.5">
              <span className="font-medium text-[var(--s-text-body)] text-xs">Password</span>
              <input
                type="password"
                required
                // Tells a password manager whether to offer a saved one or a new one; getting it
                // wrong on a combined form is the usual reason they misbehave.
                autoComplete={signingUp ? "new-password" : "current-password"}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                className={FIELD}
              />
            </label>

            {/*
              A `status`, not an `alert`: nothing is wrong with what the reader just did, and the
              two roles are announced with different urgency. Above the button, because it
              explains why the form is on screen at all.
            */}
            {notice !== undefined && (
              <p
                role="status"
                className="rounded-[10px] bg-[var(--s-surface-3)] px-3.5 py-2.5 text-[var(--s-text-muted)] text-xs leading-relaxed"
              >
                {notice}
              </p>
            )}

            {error !== undefined && (
              // A sentence for a person, so it is set like one. It used to be monospaced, which
              // is the treatment this app reserves for machine output.
              <p role="alert" className="text-[var(--color-danger)] text-xs leading-relaxed">
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={submitting}
              className={`${PILL} mt-1 bg-[var(--s-text-primary)] text-[var(--s-text-inverse)] hover:opacity-90`}
            >
              {submitting ? "One moment…" : verb}
            </button>
          </form>

          {githubEnabled && (
            <>
              {/*
                A divider rather than a second button in the stack: these two are alternatives,
                and stacked identically they read as steps.
              */}
              <div aria-hidden="true" className="my-4 flex items-center gap-3">
                <span className="h-px flex-1 bg-[var(--s-border-1)]" />
                <span className="text-[var(--s-text-subtle)] text-xs">or</span>
                <span className="h-px flex-1 bg-[var(--s-border-1)]" />
              </div>

              <button
                type="button"
                onClick={onGithub}
                disabled={submitting}
                className={`${PILL} w-full border border-[var(--s-border-1)] text-[var(--s-text-body)] hover:border-[var(--s-text-subtle)]`}
              >
                Continue with GitHub
              </button>
            </>
          )}
        </div>

        <p className="mt-6 text-center text-[var(--s-text-muted)] text-sm">
          {signingUp ? "Already have an account?" : "No account yet?"}{" "}
          <button
            type="button"
            onClick={() => onModeChange(signingUp ? "sign-in" : "sign-up")}
            className="font-medium text-[var(--s-text-primary)] underline underline-offset-4 focus-visible:outline focus-visible:outline-1 focus-visible:outline-[var(--s-text-primary)]"
          >
            {signingUp ? "Sign in" : "Create one"}
          </button>
        </p>
      </main>
    </div>
  );
}
