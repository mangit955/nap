"use client";

/**
 * The half of sign-in that talks to the server.
 *
 * Split from `SignInForm` the way `LiveProjectList` is split from `ProjectList`: everything
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
import { SignInForm, type SignInMode } from "./sign-in-form.tsx";

const DEFAULT_BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

/** What to say when the server gave us nothing to say. */
const UNKNOWN = "That did not work. Try again in a moment.";

export function LiveSignIn({ notice }: { notice?: string | undefined } = {}) {
  const router = useRouter();
  const [mode, setMode] = useState<SignInMode>("sign-in");
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

    const result =
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
      }}
      onSubmit={(credentials) => void submit(credentials)}
      onGithub={() => {
        setSubmitting(true);
        setError(undefined);
        // A full-page redirect to GitHub, so nothing after this runs.
        void authClient.signIn.social({ provider: "github", callbackURL: AFTER_SIGN_IN });
      }}
      githubEnabled={githubEnabled}
      error={error}
      submitting={submitting}
    />
  );
}
