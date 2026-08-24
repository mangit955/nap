"use client";

/**
 * The half of sign-in that talks to the server.
 *
 * Split from `SignInForm` the way `LiveDashboard` is split from `Dashboard`: everything
 * worth asserting about the form is a prop, and everything here is a request, a redirect, or
 * an error turned into a sentence — none of which jsdom can prove anything about.
 *
 * Which social providers exist is asked of the API rather than compiled in, because the
 * credentials are the API's and a build-time flag would be a second place for the truth to
 * live. Until the answer arrives no GitHub button is drawn, which is the right way round: a
 * button that appears late is better than one that disappears under a cursor.
 */

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { credentialedFetch } from "../api/credentialed-fetch.ts";
import { AFTER_DEMO_SIGN_IN, AFTER_SIGN_IN, authClient, returnTo } from "./client.ts";
import { pathForMode } from "./mode-path.ts";
import { SignInForm, type SignInMode, type SocialProvider } from "./sign-in-form.tsx";

/** The two this page knows how to draw, which is what the API's answer is narrowed to. */
const SOCIAL_PROVIDERS: readonly SocialProvider[] = ["google", "github"];

const DEFAULT_BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

/** What to say when the server gave us nothing to say. */
const UNKNOWN = "That did not work. Try again in a moment.";

/**
 * What to say when there was no server to answer.
 *
 * Deliberately not the same sentence as a refused password, and deliberately says nothing about
 * credentials: a dropped connection and a wrong password are different problems, and telling
 * somebody their password failed when the network is down sends them off to reset one that was
 * fine.
 */
const UNREACHABLE = "We couldn't reach the server. Check your connection and try again.";

/**
 * What to say when the sign-in worked and the browser threw the session away.
 *
 * Deliberately says nothing about credentials, for the reason `UNREACHABLE` does not: the server
 * accepted these ones and created the identity. What failed is storage, and telling somebody
 * their password was wrong sends them off to reset one that was fine.
 *
 * Names browsers rather than describing the mechanism, because the only useful thing a person can
 * do with this is open a different one. Turning off "Prevent cross-site tracking" also works and
 * is offered second, since it is a setting most people should not be talked into changing.
 */
const COOKIE_BLOCKED =
  "Your browser blocked the sign-in cookie, so we couldn't keep you signed in. Safari and Brave " +
  "block cookies set by another site, and Nap's API is on one. Open Nap in Chrome or Firefox, or " +
  "turn off “Prevent cross-site tracking” in Safari's privacy settings.";

/**
 * Whether the identity the server just created survived the trip into the browser.
 *
 * The failure this exists for answers **200**: Safari and Brave block third-party cookies
 * outright, so `POST /api/auth/sign-in/*` succeeds, the row is written, and the `Set-Cookie` is
 * silently refused. Nothing in the result says so — the redirect fires, every request after it is
 * a 401, and the page bounces straight back here having apparently done nothing. Asking the
 * server who we are is the only thing on this side that can tell the difference.
 *
 * Detects the *condition* rather than the browser. A user-agent test would be wrong in both
 * directions: Brave fails this way while reporting itself as Chrome, and a first-party
 * deployment — one registrable domain across both halves, which is what `docs/DEPLOY.md`
 * recommends — has no such problem in any browser.
 *
 * **Fails open**, which is the important half. This is a guard against one browser behaviour, not
 * a second gate on getting in: a blip while asking must not strand somebody whose cookie was
 * stored perfectly well. If it really was dropped, the destination bounces them back here anyway,
 * which is the behaviour this replaces rather than something worse.
 */
async function sessionSurvived(): Promise<boolean> {
  try {
    const { data } = await authClient.getSession();
    return data != null;
  } catch {
    return true;
  }
}

export function LiveSignIn({
  notice,
  initialMode = "sign-in",
}: {
  notice?: string | undefined;
  initialMode?: SignInMode;
} = {}) {
  const router = useRouter();
  const { data: session, isPending: sessionPending } = authClient.useSession();
  // Which half the form opens on, not which half it stays on: the link between the two is still
  // there, so arriving on the wrong one costs a click rather than a navigation.
  const [mode, setMode] = useState<SignInMode>(initialMode);
  const [error, setError] = useState<string | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);
  const [ways, setWays] = useState<{ social: SocialProvider[]; demo: boolean }>({
    social: [],
    demo: false,
  });

  // A guest session is still a session. Better Auth correctly refuses to mint a second anonymous
  // identity for the same browser, so a person returning to this page should continue their
  // existing free trial instead of being left with the provider's raw error.
  useEffect(() => {
    if (session != null) router.replace(AFTER_DEMO_SIGN_IN);
  }, [session, router]);

  useEffect(() => {
    let cancelled = false;

    void credentialedFetch(`${DEFAULT_BASE_URL}/auth/providers`)
      .then((response) => (response.ok ? response.json() : {}))
      .then((body: { socialProviders?: string[]; demo?: boolean }) => {
        if (cancelled) return;
        setWays({
          // Narrowed to the two this page knows how to draw. A provider the API grows before
          // this page does would otherwise become a button with no handler behind it.
          social: SOCIAL_PROVIDERS.filter((provider) => body.socialProviders?.includes(provider)),
          demo: body.demo === true,
        });
      })
      // A server that cannot say which ways in it has is one we offer none of. The email form
      // still works, and that is a better answer than a button that cannot.
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, []);

  const submit = async (credentials: { email: string; password: string; name: string }) => {
    setSubmitting(true);
    setError(undefined);

    /*
     * The client answers a *refused* sign-in with a result, and a sign-in it could not send at
     * all by throwing — an API that is down, a dropped connection, a browser offline. Without
     * this catch that rejection goes nowhere: `submitting` is never cleared, the button sits on
     * "One moment…" for as long as the page is open, and nothing on screen says why. It is the
     * worst failure this page has, and the most likely one to be seen.
     */
    let result: Awaited<ReturnType<typeof authClient.signIn.email>>;
    try {
      result =
        mode === "sign-up"
          ? await authClient.signUp.email({
              email: credentials.email,
              password: credentials.password,
              name: credentials.name,
            })
          : await authClient.signIn.email({
              email: credentials.email,
              password: credentials.password,
            });
    } catch {
      setError(UNREACHABLE);
      setSubmitting(false);
      return;
    }

    if (result.error) {
      setError(result.error.message ?? UNKNOWN);
      setSubmitting(false);
      return;
    }

    // A 200 is not the same as being signed in — see `sessionSurvived`. The button comes back
    // here, unlike the success path below, because a browser that dropped the cookie will drop
    // it again and pressing this a second time is not the way out.
    if (!(await sessionSurvived())) {
      setError(COOKIE_BLOCKED);
      setSubmitting(false);
      return;
    }

    // Not `setSubmitting(false)`: the page is on its way out, and re-enabling the button first
    // invites a second submission during the navigation.
    router.push(AFTER_SIGN_IN);
  };

  /**
   * In with no account: a throwaway identity, a real session, and straight to work.
   *
   * Lands on the dashboard rather than the key step every other route goes through. Somebody
   * who just chose "without an account" has already answered the question that page asks, and
   * putting it in front of them anyway would make "try it" mean "fill in a form".
   */
  const startDemo = async () => {
    // The effect above normally moves an existing guest away before this can be pressed. This
    // check also covers the click that lands in the small gap before the effect gets to run.
    if (session != null) {
      router.replace(AFTER_DEMO_SIGN_IN);
      return;
    }

    setSubmitting(true);
    setError(undefined);

    // Same two failure shapes as the email path: a refused sign-in answers with a result, one
    // that could not be sent at all rejects. Both leave the button stuck without this.
    try {
      const result = await authClient.signIn.anonymous();
      if (result.error) {
        setError(result.error.message ?? UNKNOWN);
        setSubmitting(false);
        return;
      }
    } catch {
      setError(UNREACHABLE);
      setSubmitting(false);
      return;
    }

    // The demo door is where this is most visible — one press, no form to blame, an immediate
    // redirect — but it is not specific to it. See `sessionSurvived`.
    if (!(await sessionSurvived())) {
      setError(COOKIE_BLOCKED);
      setSubmitting(false);
      return;
    }

    router.push(AFTER_DEMO_SIGN_IN);
  };

  return (
    <SignInForm
      notice={notice}
      mode={mode}
      onModeChange={(next) => {
        setMode(next);
        // The old complaint is about the old attempt; carrying it across reads as though the
        // mode switch itself failed.
        setError(undefined);
        // The address bar follows the form, so the URL never describes the other half — and a
        // reload lands on the one that is on screen. `replaceState` rather than `router.replace`
        // because that is a real navigation: this component would remount and the email already
        // typed would be gone. Next integrates the native call into its own router — see
        // node_modules/next/dist/docs/01-app/02-guides/single-page-applications.md.
        window.history.replaceState(null, "", pathForMode(next));
      }}
      onSubmit={(credentials) => void submit(credentials)}
      onSocial={(provider) => {
        setSubmitting(true);
        setError(undefined);
        // A full-page redirect to the provider, so nothing after this runs — unless it never
        // gets that far, which leaves the same stuck button as a failed email sign-in.
        authClient.signIn.social({ provider, callbackURL: returnTo(AFTER_SIGN_IN) }).catch(() => {
          setError(UNREACHABLE);
          setSubmitting(false);
        });
      }}
      onDemo={() => void startDemo()}
      socialProviders={ways.social}
      demoEnabled={ways.demo}
      demoPending={sessionPending}
      error={error}
      submitting={submitting}
    />
  );
}
