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
 * Errors are words in the same place every time, in a live region: what comes back from a
 * failed sign-in is the only thing on this screen anybody needs to read, and a message that
 * changes only visually is one a screen reader never mentions.
 */

import { useState } from "react";

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

const FIELD =
  "w-full rounded border border-edge bg-surface px-3 py-2 text-ink text-sm " +
  "placeholder:text-muted focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent";

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

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center gap-6 px-6 py-12">
      <header className="flex flex-col gap-1">
        <h1 className="font-semibold text-ink text-lg tracking-tight">nap</h1>
        <p className="text-muted text-xs">describe an app, watch it get built</p>
      </header>

      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit({ email, password, name });
        }}
      >
        {signingUp && (
          <label className="flex flex-col gap-1.5">
            <span className="text-muted text-xs">Name</span>
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
          <span className="text-muted text-xs">Email</span>
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
          <span className="text-muted text-xs">Password</span>
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
          two roles are announced with different urgency. Above the fields, because it explains
          why the form is on screen at all.
        */}
        {notice !== undefined && (
          <p role="status" className="rounded border border-edge px-3 py-2 text-muted text-xs">
            {notice}
          </p>
        )}

        {error !== undefined && (
          <p role="alert" className="font-mono text-danger text-xs">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={submitting}
          className="mt-1 rounded border border-accent px-3 py-2 font-medium text-accent text-xs hover:bg-accent/10 focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent disabled:opacity-50"
        >
          {submitting ? "One moment…" : verb}
        </button>
      </form>

      {githubEnabled && (
        <button
          type="button"
          onClick={onGithub}
          disabled={submitting}
          className="rounded border border-edge px-3 py-2 text-ink text-xs hover:bg-panel focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent disabled:opacity-50"
        >
          Continue with GitHub
        </button>
      )}

      <p className="text-muted text-xs">
        {signingUp ? "Already have an account?" : "No account yet?"}{" "}
        <button
          type="button"
          onClick={() => onModeChange(signingUp ? "sign-in" : "sign-up")}
          className="text-accent underline underline-offset-2 focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
        >
          {signingUp ? "Sign in" : "Create one"}
        </button>
      </p>
    </main>
  );
}
