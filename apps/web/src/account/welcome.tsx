"use client";

/**
 * The first-run step for adding a model API key. Skipping opens the dashboard for browsing;
 * whether work can run without a key depends on the deployment's free-tier policy.
 *
 * **It shows itself once.** Anybody who already has a key saved is sent on without seeing it,
 * and skipping is remembered in `localStorage`, so this is a first-run step rather than a page
 * that reappears on every sign-in. A column for that would be schema for something nothing else
 * reads, and the wrong answer — showing it again on a new browser — costs one click.
 *
 * The demo path never arrives here: somebody who chose "without an account" has already
 * answered the question this page asks. See `AFTER_DEMO_SIGN_IN`.
 *
 * **It is drawn in the sign-up page's voice**, because that is the page somebody left a second
 * ago: the same dark ground, serif heading, muted Inter and mark in the corner (`.landing` and
 * `.lp-serif`, see `auth/sign-in-form.tsx`). Those faces load only inside the `(landing)` route
 * group, which is why this page's route lives there. Sign-up's photograph is not repeated; the
 * column stands alone in the middle of the screen. The key form is shared with the dialog over
 * the workspace and paints itself in the `--s-*` ramp, so it is mounted in `.ai-stage-dark`,
 * which maps that ramp onto the app's dark tokens.
 */

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { NapMark } from "../brand/nap-mark.tsx";
import { SpinnerIcon } from "../ui/icons.tsx";
import { ApiKeyForm } from "./api-key-form.tsx";
import { useApiKey } from "./use-api-key.ts";

/** Where the person goes once they have answered, either way. */
const AFTER = "/dashboard";

/**
 * That this step has been seen. A browser preference, not a fact about the account.
 *
 * Read through a try/catch because `localStorage` throws rather than returning null in a
 * private window in some browsers — and a page that crashes on its own dismissal memory would
 * take the whole sign-up flow with it.
 */
const SKIPPED_KEY = "nap.welcome.skipped";

export function hasSkippedWelcome(): boolean {
  try {
    return globalThis.localStorage?.getItem(SKIPPED_KEY) === "true";
  } catch {
    return false;
  }
}

function rememberSkip(): void {
  try {
    globalThis.localStorage?.setItem(SKIPPED_KEY, "true");
  } catch {
    // Somebody who dismissed this and will be asked again next time. Not worth a word on screen.
  }
}

export function Welcome() {
  const router = useRouter();
  const { state, loaded, error, busy, save } = useApiKey();

  // Somebody who already said no is not asked again, which is the whole point of remembering it.
  // Checked before anything is known and without a request, because the answer is already in this
  // browser: a skipper never sees this page at all rather than seeing it until the server replies.
  const skipped = hasSkippedWelcome();

  useEffect(() => {
    if (skipped) router.replace(AFTER);
  }, [skipped, router]);

  // Sent straight on if there is already a key, so this is a first-run step and not a page
  // between somebody and their work every time they sign in. `undefined` means the answer has
  // not arrived — deliberately not treated as "no key", which would flash the form at
  // somebody who has one.
  useEffect(() => {
    if (state?.configured === true) router.replace(AFTER);
  }, [state, router]);

  /*
   * Nothing but a spinner until it is known whether this page is needed.
   *
   * This used to draw the paste form while it waited, on the reasoning that the form is what
   * almost everybody landing here needs. What that missed is the other case: somebody who saved
   * a key months ago signs in, is shown a form asking for the key they already gave, and is then
   * yanked to the dashboard when the answer lands. Being asked a question you have answered is a
   * worse first second than a moment of nothing.
   *
   * `loaded` rather than `state === undefined`, so a server that cannot be reached ends up at the
   * form — where a key can still be pasted — instead of spinning here forever.
   */
  const deciding = !loaded || skipped || state?.configured === true;

  const skip = () => {
    rememberSkip();
    router.push(AFTER);
  };

  return (
    <div className="landing relative flex min-h-dvh flex-col items-center justify-center px-6 py-24">
      {/*
        Where sign-up put it, so the corner does not jump between the two pages. Focus is the
        landing's own ring, drawn in the text's colour.
      */}
      <a
        href="/"
        aria-label="nap, back to the front page"
        className="absolute top-5 left-6 flex h-9 items-center gap-[7px] font-semibold text-(--lp-ink) text-[19px] tracking-[-0.03em] lg:top-7 lg:left-10"
      >
        <NapMark className="size-[26px]" />
        nap
      </a>

      <main className="w-full max-w-[360px]">
        {/*
          Wait for the account check before asking for a key somebody may already have saved.
        */}
        {deciding ? (
          <p role="status" className="flex items-center justify-center py-10 text-(--lp-ink-3)">
            <SpinnerIcon className="size-6" />
            <span className="sr-only">Checking your account…</span>
          </p>
        ) : (
          <>
            {/*
              Broken by hand: left to wrap, or to `text-balance`, the serif at this size splits
              the phrase as "Bring your / own API key.", parting "own" from what is owned.
            */}
            <h1 className="lp-serif text-[40px] leading-[1.05] lg:text-[44px]">
              Bring your own <br />
              API key.
            </h1>
            <p className="lp-muted mt-3 text-[14.5px] leading-normal">
              Add an OpenRouter or Anthropic key to run models on your account. Work without a key
              is available only when this deployment offers a free tier.
            </p>

            {/* No card around it: sign-up's fields stand on the ground, and so do these. */}
            <div className="ai-stage-dark mt-8">
              <ApiKeyForm
                // Only ever the unconfigured form: a saved key redirects above, and this branch
                // is not reached until the answer has arrived. A server that could not be asked
                // lands here too, which is right — a key can still be pasted.
                state={state ?? { configured: false }}
                onSave={(apiKey) => {
                  void save(apiKey).then((saved) => {
                    if (saved) router.push(AFTER);
                  });
                }}
                // Unreachable from this page — a key that is already saved sends the person on
                // before the form renders — but the prop is required, and routing to the
                // dashboard is the honest answer to "I no longer want this key" wherever it is
                // pressed.
                onRemove={skip}
                error={error}
                busy={busy}
              />
            </div>

            {/*
              Set like sign-up's "try it without an account": a quiet line under the form, since
              it is the other answer to the question rather than the one the page is asking for.
            */}
            <p className="mt-6 text-center">
              <button
                type="button"
                onClick={skip}
                className="text-(--lp-ink-2) text-[13.5px] underline decoration-(--lp-ink-3) underline-offset-4 transition-colors hover:text-(--lp-ink)"
              >
                Continue to dashboard
              </button>
            </p>
          </>
        )}
      </main>
    </div>
  );
}
