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
import { AFTER_SIGN_IN, authClient } from "./client.ts";
import { pathForMode } from "./mode-path.ts";
import { SignInForm, type SignInMode } from "./sign-in-form.tsx";

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

export function LiveSignIn({
  notice,
  initialMode = "sign-in",
}: {
  notice?: string | undefined;
  initialMode?: SignInMode;
} = {}) {
  const router = useRouter();
  // Which half the form opens on, not which half it stays on: the link between the two is still
  // there, so arriving on the wrong one costs a click rather than a navigation.
  const [mode, setMode] = useState<SignInMode>(initialMode);
  const [error, setError] = useState<string | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);
  const [githubEnabled, setGithubEnabled] = useState(false);

  useEffect(() => {
    let cancelled = false;

    void credentialedFetch(`${DEFAULT_BASE_URL}/auth/providers`)
      .then((response) => (response.ok ? response.json() : { socialProviders: [] }))
      .then((body: { socialProviders?: string[] }) => {
        if (!cancelled) setGithubEnabled(body.socialProviders?.includes("github") === true);
      })
      // A server that cannot say which providers it has is one we offer none of. The email
      // form still works, and that is a better answer than a button that cannot.
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

    // Not `setSubmitting(false)`: the page is on its way out, and re-enabling the button first
    // invites a second submission during the navigation.
    router.push(AFTER_SIGN_IN);
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
      onGithub={() => {
        setSubmitting(true);
        setError(undefined);
        // A full-page redirect to GitHub, so nothing after this runs — unless it never gets
        // that far, which leaves the same stuck button as a failed email sign-in.
        authClient.signIn.social({ provider: "github", callbackURL: AFTER_SIGN_IN }).catch(() => {
          setError(UNREACHABLE);
          setSubmitting(false);
        });
      }}
      githubEnabled={githubEnabled}
      error={error}
      submitting={submitting}
    />
  );
}
