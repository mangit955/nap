"use client";

/**
 * The step between signing up and working: bring a key, or don't.
 *
 * **It is an offer, and skipping it is a first-class answer.** Whoever lands here already has a
 * working account on the free models; a key buys Opus and the paid GPT models and nothing else.
 * That is why "Just try it free" is a real button beside the form rather than a grey link under
 * it — a first-run step that reads as a toll booth is one people bounce off, and this one has
 * nothing behind it worth bouncing off for.
 *
 * **It shows itself once.** Anybody who already has a key saved is sent on without seeing it,
 * and skipping is remembered in `localStorage`, so this is a first-run step rather than a page
 * that reappears on every sign-in. A column for that would be schema for something nothing else
 * reads, and the wrong answer — showing it again on a new browser — costs one click.
 *
 * The demo path never arrives here: somebody who chose "without an account" has already
 * answered the question this page asks. See `AFTER_DEMO_SIGN_IN`.
 */

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { NapMark } from "../brand/nap-mark.tsx";
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
  const { state, error, busy, save } = useApiKey();

  // Sent straight on if there is already a key, so this is a first-run step and not a page
  // between somebody and their work every time they sign in. `undefined` means the answer has
  // not arrived — deliberately not treated as "no key", which would flash the form at
  // somebody who has one.
  useEffect(() => {
    if (state?.configured === true) router.replace(AFTER);
  }, [state, router]);

  const skip = () => {
    rememberSkip();
    router.push(AFTER);
  };

  return (
    <div className="ai-stage relative flex min-h-dvh flex-col items-center justify-center px-6 py-20">
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
          One more thing —{" "}
          <span className="font-semibold text-[var(--s-text-primary)]">optional.</span>
        </h1>
        <p className="mt-2.5 text-balance text-center text-[var(--s-text-muted)] text-sm">
          Nap runs on free models out of the box. Bring your own API key to build with Claude Opus
          and the paid GPT models instead.
        </p>

        <div className="mt-8 rounded-[20px] border border-[var(--s-border-1)] bg-[var(--s-surface-1)] p-6 shadow-[0_1px_2px_rgba(12,38,77,0.06),0_10px_30px_-12px_rgba(12,38,77,0.18)]">
          <ApiKeyForm
            // Until the answer arrives, the paste form is the right thing to draw: it is what
            // almost everybody landing here needs, and the redirect above catches the rest.
            state={state ?? { configured: false }}
            onSave={(apiKey) => {
              void save(apiKey).then((saved) => {
                if (saved) router.push(AFTER);
              });
            }}
            // Unreachable from this page — a key that is already saved sends the person on
            // before the form renders — but the prop is required, and routing to the dashboard
            // is the honest answer to "I no longer want this key" wherever it is pressed.
            onRemove={skip}
            error={error}
            busy={busy}
          />
        </div>

        <p className="mt-6 text-center">
          <button
            type="button"
            onClick={skip}
            className="font-medium text-[var(--s-text-primary)] text-sm underline underline-offset-4 focus-visible:outline focus-visible:outline-1 focus-visible:outline-[var(--s-text-primary)]"
          >
            Just try it free
          </button>
        </p>
      </main>
    </div>
  );
}
