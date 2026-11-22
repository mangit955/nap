/**
 * The way in: an email and a password, or a provider.
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
 * **It is drawn in the front page's voice.** "Get started" on that page is a dark, serif,
 * photographic surface, and landing on a page that looks like a different product is a bad
 * thing to do to somebody one step from an account. So this wears `.landing`, which carries the
 * front page's tokens and Inter, and sets its headings in `.lp-serif`. Both faces are loaded only
 * by the `(landing)` route group's layout, which is why `/sign-in` and `/sign-up` live in that
 * group — outside it the serif quietly falls back to Georgia (`app/font-placement.test.ts`).
 *
 * Errors are words in the same place every time, in a live region: what comes back from a
 * failed sign-in is the only thing on this screen anybody needs to read, and a message that
 * changes only visually is one a screen reader never mentions.
 */

import type { ReactElement } from "react";
import { useState } from "react";
import { NapMark } from "../brand/nap-mark.tsx";
import { GithubIcon, GoogleIcon, type IconProps, SpinnerIcon } from "../ui/icons.tsx";

export type SignInMode = "sign-in" | "sign-up";

/** The identity providers this page can offer. Which are *offered* is the API's answer. */
export type SocialProvider = "google" | "github";

/**
 * Each social button, in the order they are drawn.
 *
 * Google first because it is the one most people have and the one fewest people have to think
 * about. The order is fixed here rather than following whatever order the API listed them in:
 * a menu that reorders itself between deployments is one nobody builds muscle memory for.
 *
 * The button shows the provider's name and is announced as the whole sentence. The visible word
 * is inside the spoken one, so somebody using voice control can say what they see.
 */
const SOCIAL: readonly {
  provider: SocialProvider;
  name: string;
  label: string;
  Icon: (props: IconProps) => ReactElement;
}[] = [
  { provider: "google", name: "Google", label: "Continue with Google", Icon: GoogleIcon },
  { provider: "github", name: "GitHub", label: "Continue with GitHub", Icon: GithubIcon },
];

export type SignInFormProps = {
  mode: SignInMode;
  onModeChange: (mode: SignInMode) => void;
  onSubmit: (credentials: { email: string; password: string; name: string }) => void;
  /** Pressing one of the social buttons, named by which. */
  onSocial: (provider: SocialProvider) => void;
  /**
   * Going in without an account at all. A different kind of act from the others — nothing is
   * being proved about who you are — so it is a quiet line under the form rather than a button
   * beside the providers.
   */
  onDemo: () => void;
  /** Only the providers the API actually has credentials for; see `/auth/providers`. */
  socialProviders: readonly SocialProvider[];
  /**
   * The API has not said yet which providers it has, so their row is held open, empty: when
   * the answer brings providers they fill it where it stands and nothing below them moves.
   */
  socialPending?: boolean;
  /**
   * Keep the controls hidden: the answer is still due and may yet move them.
   *
   * The providers' row sits above the email form, so the answer moves the fields: a row
   * arriving pushes Email down onto Google or GitHub, and a row that turns out empty pulls the
   * submit button up to where Email was, under a thumb, with a password manager's credentials
   * already filled. Holding space cannot cure both, so the controls are drawn once the answer
   * is in. A lookup that is slow rather than answered gets the form anyway, with the row still
   * held open for a late answer to fill; see `LiveSignIn`.
   */
  controlsHeld?: boolean;
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

const COPY: Record<SignInMode, { title: string; sub: string }> = {
  "sign-in": { title: "Welcome back.", sub: "Your apps are where you left them." },
  "sign-up": { title: "Start a nap.", sub: "Describe an app; we'll build it while you're gone." },
};

/*
 * One radius for every field and button, and fills and borders barely off the ground: on a page
 * this dark, anything brighter turns the form into a stack of boxes louder than the words in it.
 *
 * The placeholder is the field's only visible name, so it is held to body-text contrast (about
 * 5:1 on the fill) rather than the dimmer grey placeholders usually get.
 *
 * 16px on the input is not a style choice: below it, iOS zooms the page in on focus and does not
 * zoom back out, which leaves somebody halfway through signing up looking at a form twice the
 * width of their screen.
 *
 * Focus is the border turning warm, and `outline-hidden` rather than `outline-none`: forced-colors
 * mode (Windows High Contrast) repaints every border in one system colour, so the warm border
 * vanishes there, and `outline-hidden` is the one that gives the outline back in that mode.
 */
const FIELD =
  "h-[46px] w-full rounded-xl border border-[#ffffff0f] bg-[#ffffff06] px-3.5 text-[16px] " +
  "text-(--lp-ink) outline-hidden transition-colors placeholder:text-[#858180] " +
  "focus-visible:border-[#d6b89e8c] focus-visible:bg-[#ffffff09]";

const GHOST_BUTTON =
  "flex h-11 flex-1 items-center justify-center gap-[9px] rounded-xl border border-[#ffffff0f] " +
  "bg-[#ffffff06] font-medium text-(--lp-ink-2) text-[13.5px] transition-colors " +
  "hover:border-[#ffffff1f] hover:text-(--lp-ink) disabled:opacity-50";

export function SignInForm({
  mode,
  onModeChange,
  onSubmit,
  onSocial,
  onDemo,
  socialProviders,
  socialPending = false,
  controlsHeld = false,
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
  const providerRow = socialPending || offered.length > 0;
  // `visibility`, not `display` or opacity: the controls keep their place, cannot be focused,
  // clicked or read out while hidden, and nothing below them moves when they appear. Inline so
  // a test's computed style can see it.
  const held = controlsHeld ? ({ visibility: "hidden" } as const) : undefined;

  return (
    <div className="landing min-h-dvh lg:grid lg:grid-cols-2">
      <div className="relative flex min-h-dvh flex-col px-6 pb-7 lg:px-10 lg:pt-7">
        {/*
          On a phone the photo has no column of its own, so it becomes a strip across the top
          that fades into the ground — enough of it to say this is the same place as the front
          page, without pushing the form below the fold.
        */}
        <div aria-hidden="true" className="relative -mx-6 h-[190px] lg:hidden">
          <div className="absolute inset-0 bg-[url(/landing/auth-midnight.webp)] bg-[center_44%] bg-cover" />
          <div className="absolute inset-0 bg-linear-to-b from-[#09090b80] via-[#09090b00] via-40% to-(--lp-ground)" />
        </div>

        {/*
          The mark is the way back out. An auth page with no exit is a dead end for anybody who
          arrived by accident, and the wordmark is the one thing on it people already know is a
          link everywhere else.

          It is lifted above the phone's photo strip and nowhere else. On a wide screen it is a
          flex item, and a flex item with a z-index stacks even unpositioned: stretched to the
          column's width it lay over the mode switch in the corner and took every click on it.
          Hence `lg:z-auto`, and `lg:self-start` so it is only as wide as what it says.
        */}
        <a
          href="/"
          aria-label="nap, back to the front page"
          className="absolute top-5 left-6 z-[2] flex h-9 items-center gap-[7px] font-semibold text-(--lp-ink) text-[19px] tracking-[-0.03em] lg:static lg:z-auto lg:self-start"
        >
          <NapMark className="size-[26px]" />
          nap
        </a>

        <main className="relative z-[2] -mt-2 flex justify-center lg:mt-0 lg:flex-1 lg:items-center">
          <div className="w-full max-w-[340px]">
            <h1 className="lp-serif text-[40px] leading-none lg:text-[44px]">{copy.title}</h1>
            <p className="lp-muted mt-3 text-[14.5px] leading-normal">{copy.sub}</p>

            {/*
              A `status`, not an `alert`: nothing is wrong with what the reader just did, and the
              two roles are announced with different urgency. Under the heading, because it
              explains why the form is on screen at all, and outside the held controls, because
              it is known before the page is drawn and is worth reading while they wait.
            */}
            {notice !== undefined && (
              <p
                role="status"
                className="mt-6 rounded-xl border border-[#ffffff0f] bg-[#ffffff06] px-3.5 py-2.5 text-(--lp-ink-2) text-[13px] leading-relaxed"
              >
                {notice}
              </p>
            )}

            {/*
              The held controls are invisible, so somebody reading the page by ear meets this
              line under the heading rather than nothing at all. Present only while they are
              held: a page with nothing to report carries no status (`failure-surfaces.test`).
            */}
            {controlsHeld && (
              <p role="status" className="sr-only">
                Loading the ways to sign in…
              </p>
            )}

            <div style={held} aria-busy={controlsHeld || undefined}>
              {/*
              The providers come first because they are the shortest way in, and each shows its
              name as well as its mark: two bare logos side by side read as decoration.
            */}
              {providerRow && (
                <>
                  <div className="mt-[30px] flex gap-2 lg:mt-9">
                    {socialPending && (
                      <>
                        <span
                          aria-hidden="true"
                          data-testid="providers-pending"
                          className={GHOST_BUTTON}
                        />
                        <span aria-hidden="true" className={GHOST_BUTTON} />
                      </>
                    )}
                    {offered.map(({ provider, name: providerName, label, Icon }) => (
                      <button
                        key={provider}
                        type="button"
                        aria-label={label}
                        onClick={() => onSocial(provider)}
                        disabled={submitting}
                        className={GHOST_BUTTON}
                      >
                        <Icon className="size-[15px]" />
                        {providerName}
                      </button>
                    ))}
                  </div>

                  <div
                    aria-hidden="true"
                    className="my-6 flex items-center gap-3.5 text-[#5d5a58] text-xs"
                  >
                    <span className="h-px flex-1 bg-[#ffffff0f]" />
                    or
                    <span className="h-px flex-1 bg-[#ffffff0f]" />
                  </div>
                </>
              )}

              <form
                className={`flex flex-col gap-2.5 ${providerRow ? "" : "mt-[30px] lg:mt-9"}`}
                onSubmit={(event) => {
                  event.preventDefault();
                  onSubmit({ email, password, name });
                }}
              >
                {/*
                No label is drawn above a field — the placeholder names it — but each still has
                one, hidden, so a screen reader and a password manager know what it is for.
              */}
                {signingUp && (
                  <label>
                    <span className="sr-only">Name</span>
                    <input
                      type="text"
                      required
                      autoComplete="name"
                      placeholder="Name"
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                      className={FIELD}
                    />
                  </label>
                )}

                <label>
                  <span className="sr-only">Email</span>
                  <input
                    type="email"
                    required
                    autoComplete="email"
                    placeholder="Email"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    className={FIELD}
                  />
                </label>

                <label>
                  <span className="sr-only">Password</span>
                  <input
                    type="password"
                    required
                    // Tells a password manager whether to offer a saved one or a new one; getting
                    // it wrong on a combined form is the usual reason they misbehave.
                    autoComplete={signingUp ? "new-password" : "current-password"}
                    placeholder="Password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    className={FIELD}
                  />
                </label>

                {error !== undefined && (
                  // A sentence for a person, so it is set like one, in the app's one red — which
                  // still reads at better than 5:1 on this ground.
                  <p role="alert" className="text-(--color-danger) text-[13px] leading-relaxed">
                    {error}
                  </p>
                )}

                {/*
                In flight, the words gain a turning ring beside them.

                The sentence says what is happening and the ring says it is still happening —
                "One moment…" on its own stops being believable the instant it sits still,
                because a stalled request and a slow one read identically. The ring trails the
                words, so the text starts where the label it replaced started, and it is 20px to
                match the line beside it, so the button does not change height when pressed.

                The outline is set here because the page's default draws focus in the text's own
                colour, and this text is dark on a dark ground.
              */}
                <button
                  type="submit"
                  disabled={submitting}
                  className="mt-2 flex h-[46px] items-center justify-center gap-2 rounded-xl bg-[#f1ede8] font-medium text-[#151411] text-sm shadow-[inset_0_1px_0_#fff,0_1px_2px_#0003] transition-colors hover:bg-white focus-visible:outline-(--lp-ink) focus-visible:outline-offset-3 disabled:opacity-60"
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

              {/*
              With no guest door the line is still there, invisibly, so the form is the same
              height either way: on a wide screen it is centred, and an answer that removed a
              line under it after it was shown would drop every field by half that line.
            */}
              {!demoEnabled && (
                <p aria-hidden="true" className="invisible mt-5 text-[13px]">
                  &nbsp;
                </p>
              )}
              {demoEnabled && (
                <p className="lp-muted mt-5 text-center text-[13px]">
                  or{" "}
                  <button
                    type="button"
                    onClick={onDemo}
                    disabled={submitting || demoPending}
                    // Underlined because its colour alone sits too close to the "or" beside it to
                    // say it can be pressed; the line is held to about 3:1 so it is seen.
                    className="text-(--lp-ink-2) underline decoration-[#ffffff66] underline-offset-4 transition-colors hover:text-(--lp-ink) disabled:opacity-50"
                  >
                    try it without an account
                  </button>
                </p>
              )}
            </div>
          </div>
        </main>

        {/*
          Rendered once and moved by the layout: top right beside the mark on a wide screen,
          under the form on a phone. Two copies would put two "Sign in" buttons on the page for a
          screen reader, one of them hidden.
        */}
        <p
          style={held}
          className="lp-muted mt-7 text-center text-[13.5px] lg:absolute lg:top-7 lg:right-10 lg:mt-0 lg:flex lg:h-9 lg:items-center lg:gap-1.5"
        >
          {signingUp ? "Have an account?" : "No account yet?"}{" "}
          <button
            type="button"
            onClick={() => onModeChange(signingUp ? "sign-in" : "sign-up")}
            className="text-(--lp-ink) transition-colors hover:text-white"
          >
            {signingUp ? "Sign in" : "Create one"}
          </button>
        </p>
      </div>

      {/*
        The caption repeats the front page's tagline, so the caption and image are decorative.
      */}
      <div
        aria-hidden="true"
        className="relative m-2.5 ml-0 hidden overflow-hidden rounded-[20px] lg:block"
      >
        <div className="absolute inset-0 bg-[url(/landing/auth-midnight.webp)] bg-[center_75%] bg-cover" />
        <div className="absolute inset-0 bg-linear-to-b from-[#09090b00] from-55% to-[#09090bb3]" />
        <p className="lp-serif absolute bottom-9 left-10 text-(--lp-ink) text-[34px] leading-[1.05]">
          Describe an app.
          <br />
          <span className="text-[#d9cabc]">Then go take a nap.</span>
        </p>
      </div>
    </div>
  );
}
