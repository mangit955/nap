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

import type { ReactElement } from "react";
import { useState } from "react";
import { NapMark } from "../brand/nap-mark.tsx";
import { GithubIcon, GoogleIcon, type IconProps, SpinnerIcon } from "../ui/icons.tsx";
import { DoodleWall } from "./doodle-wall.tsx";

export type SignInMode = "sign-in" | "sign-up";

/** The identity providers this page can offer. Which are *offered* is the API's answer. */
export type SocialProvider = "google" | "github";

/**
 * What each social button says, in the order they are drawn.
 *
 * Google first because it is the one most people have and the one fewest people have to think
 * about. The order is fixed here rather than following whatever order the API listed them in:
 * a menu that reorders itself between deployments is one nobody builds muscle memory for.
 */
const SOCIAL: readonly {
  provider: SocialProvider;
  label: string;
  Icon: (props: IconProps) => ReactElement;
}[] = [
  { provider: "google", label: "Continue with Google", Icon: GoogleIcon },
  { provider: "github", label: "Continue with GitHub", Icon: GithubIcon },
];

export type SignInFormProps = {
  mode: SignInMode;
  onModeChange: (mode: SignInMode) => void;
  onSubmit: (credentials: { email: string; password: string; name: string }) => void;
  /** Pressing one of the social buttons, named by which. */
  onSocial: (provider: SocialProvider) => void;
  /**
   * Going in without an account at all.
   *
   * Still a different kind of act from the three above it — nothing is being proved about who
   * you are — but it sits in the same row as the providers, because a person weighing "how do I
   * get in" is weighing all three at once and one of them being elsewhere on the page hides it.
   * It stays distinguishable by shape: words where the others are marks.
   */
  onDemo: () => void;
  /** Only the providers the API actually has credentials for; see `/auth/providers`. */
  socialProviders: readonly SocialProvider[];
  /** Whether this deployment lets anybody in without an account at all. */
  demoEnabled: boolean;
  /** In words, for the person who just tried. Undefined when nothing has gone wrong. */
  error?: string | undefined;
  /**
   * Why they are here, when they did not choose to be — an expired session, arriving from a
   * redirect. Distinct from `error`: nothing they did was wrong, and drawing it in the same red
   * as a bad password would say otherwise.
   */
  notice?: string | undefined;
  submitting?: boolean;
  /** Keep the guest door closed until we know whether this browser already has a guest session. */
  demoPending?: boolean;
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

/**
 * A provider button with no words in it.
 *
 * Square-ish and fixed at 44px, which is the smallest target iOS and Android both call reliably
 * tappable — an icon-only control is the one shape where that floor is easy to fall through.
 * The name lives in `aria-label`, so a screen reader still hears the full sentence; `title`
 * gives a pointer the same sentence on hover.
 */
const ICON_BUTTON =
  "flex size-11 shrink-0 items-center justify-center rounded-full border " +
  "border-[var(--s-border-1)] bg-[var(--s-surface-1)] text-[var(--s-text-body)] transition-colors " +
  "hover:border-[var(--s-text-subtle)] focus-visible:outline focus-visible:outline-2 " +
  "focus-visible:outline-offset-2 focus-visible:outline-[var(--s-text-primary)] disabled:opacity-50";

export function SignInForm({
  mode,
  onModeChange,
  onSubmit,
  onSocial,
  onDemo,
  socialProviders,
  demoEnabled,
  error,
  notice,
  submitting = false,
  demoPending = false,
}: SignInFormProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");

  const signingUp = mode === "sign-up";
  const verb = signingUp ? "Create account" : "Sign in";
  const copy = COPY[mode];
  // This page's order, filtered by what the API has credentials for — rather than the API's
  // order, which is an implementation detail of how boot happens to check them.
  const offered = SOCIAL.filter(({ provider }) => socialProviders.includes(provider));

  return (
    <div className="ai-stage relative flex min-h-dvh flex-col items-center justify-center px-6 py-20">
      {/*
        The paper this is written on. A large light surface with one object in the middle of it
        reads as unfinished rather than as calm — the same problem the landing page has, answered
        the same way and much further: a sheet of doodles covering the page, with a clearing
        masked through the middle so the form still sits on plain white.
      */}
      <DoodleWall />

      {/*
        The mark is the way back out. An auth page with no exit is a dead end for anybody who
        arrived by accident, and the wordmark is the one thing on it people already know is a
        link everywhere else.
      */}
      <a
        href="/"
        aria-label="nap, back to the front page"
        className="absolute top-4 left-6 z-10 flex items-center gap-0.5 font-semibold text-[var(--s-text-primary)] text-sm tracking-tight focus-visible:outline focus-visible:outline-1 focus-visible:outline-[var(--s-text-primary)]"
      >
        <NapMark className="size-10" />
        nap
      </a>

      <main className="relative z-10 flex w-full max-w-sm flex-col">
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

            {/*
              In flight, the words gain a turning ring beside them.

              The sentence says what is happening and the ring says it is still happening —
              "One moment…" on its own stops being believable the instant it sits still, because
              a stalled request and a slow one read identically. The ring trails the words rather
              than leading them, so the thing that changes is the last thing on the line and the
              text starts where the label it replaced started.

              The ring is 20px to match the line height beside it, so the button does not change
              height at the moment it is pressed.
            */}
            <button
              type="submit"
              disabled={submitting}
              className={`${PILL} mt-1 flex items-center justify-center gap-2 bg-[var(--s-text-primary)] text-[var(--s-text-inverse)] hover:opacity-90`}
            >
              {submitting ? (
                <>
                  One moment…
                  <SpinnerIcon className="size-5" />
                </>
              ) : (
                verb
              )}
            </button>
          </form>

          {(offered.length > 0 || demoEnabled) && (
            <>
              {/*
                A divider rather than more buttons in the stack: these are alternatives to the
                form above, and stacked identically they read as steps.
              */}
              <div aria-hidden="true" className="my-4 flex items-center gap-3">
                <span className="h-px flex-1 bg-[var(--s-border-1)]" />
                <span className="text-[var(--s-text-subtle)] text-xs">or</span>
                <span className="h-px flex-1 bg-[var(--s-border-1)]" />
              </div>

              {/*
                One row for every way in that is not an email address. The providers are marks
                rather than sentences because "Continue with Google" is a label nobody reads
                twice — the logo is what people scan for — and two full-width pills saying almost
                the same words were the loudest thing on a page whose actual subject is the form
                above them. Centred, so two marks alone still look placed rather than orphaned.
              */}
              <div className="flex items-center justify-center gap-2">
                {offered.map(({ provider, label, Icon }) => (
                  <button
                    key={provider}
                    type="button"
                    aria-label={label}
                    title={label}
                    onClick={() => onSocial(provider)}
                    disabled={submitting}
                    className={ICON_BUTTON}
                  >
                    <Icon className="size-[18px]" />
                  </button>
                ))}

                {demoEnabled && (
                  <button
                    type="button"
                    onClick={onDemo}
                    disabled={submitting || demoPending}
                    className={`${PILL} flex-1 border border-[var(--s-border-1)] text-[var(--s-text-body)] transition-colors hover:border-[var(--s-text-subtle)]`}
                  >
                    Try for free
                  </button>
                )}
              </div>

              {/*
                What the free door costs, said before it is opened rather than at the model
                picker, where the good models being greyed out with no explanation reads as a
                fault. Kept out of the button so the button stays one short phrase.
              */}
              {demoEnabled && (
                <p className="mt-3 text-center text-[var(--s-text-subtle)] text-xs">
                  No account, free models, nothing to set up.
                </p>
              )}
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
