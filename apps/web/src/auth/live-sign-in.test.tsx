import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The half of sign-in jsdom *can* prove something about: what happens to the form when the
 * request comes back badly, or does not come back at all.
 *
 * Mocked at the module boundary, the way `live-chat-pane.test.tsx` does it — the auth client and
 * the router are the two things this component talks to, and neither can be reached from a test.
 */

const push = vi.fn();
const replace = vi.fn();
const useSession = vi.fn();
const signInEmail = vi.fn();
const signUpEmail = vi.fn();
const signInSocial = vi.fn();
const signInAnonymous = vi.fn();
const getSession = vi.fn();
/** What `/auth/providers` answers with, per test. */
const ways = { socialProviders: [] as string[], demo: false };

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace, refresh: vi.fn() }),
}));

vi.mock("./client.ts", () => ({
  AFTER_SIGN_IN: "/welcome",
  AFTER_DEMO_SIGN_IN: "/dashboard",
  returnTo: (path: string) => new URL(path, window.location.origin).toString(),
  authClient: {
    useSession: () => useSession(),
    getSession: (...args: unknown[]) => getSession(...args),
    signIn: {
      email: (...args: unknown[]) => signInEmail(...args),
      social: (...args: unknown[]) => signInSocial(...args),
      anonymous: (...args: unknown[]) => signInAnonymous(...args),
    },
    signUp: { email: (...args: unknown[]) => signUpEmail(...args) },
  },
}));

// The providers lookup is a real network call in an effect; left alone it reaches for a server
// that is not there and the test waits on the failure.
vi.mock("../api/credentialed-fetch.ts", () => ({
  credentialedFetch: () => Promise.resolve(new Response(JSON.stringify(ways))),
}));

const { LiveSignIn } = await import("./live-sign-in.tsx");

function submit(email = "ada@example.com", password = "a good password") {
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: email } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: password } });
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
}

beforeEach(() => {
  vi.clearAllMocks();
  useSession.mockReturnValue({ data: null, isPending: false });
  // The cookie stuck, which is every browser but the ones below. Tests that care say otherwise.
  getSession.mockResolvedValue({ data: { user: { id: "u1" } } });
  ways.socialProviders = [];
  ways.demo = false;
  window.history.replaceState(null, "", "/sign-in");
});

describe("when the server refuses the credentials", () => {
  it("says what it said, and lets them try again", async () => {
    signInEmail.mockResolvedValue({ error: { message: "That email and password do not match." } });
    render(<LiveSignIn />);

    submit();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "That email and password do not match.",
    );
    expect(screen.getByRole("button", { name: "Sign in" })).toBeEnabled();
  });
});

describe("when the server cannot be reached at all", () => {
  it("says so, rather than sitting on the spinner forever", async () => {
    // The rejection case, which is what an API that is down or a dropped connection produces —
    // the client throws rather than answering. Uncaught, the promise dies silently, the button
    // never comes back from "One moment…", and there is nothing on screen to explain it. That is
    // the worst failure this page has: nothing to read, nothing to press, no way to know it is
    // not still trying.
    signInEmail.mockRejectedValue(new TypeError("Failed to fetch"));
    render(<LiveSignIn />);

    submit();

    expect(await screen.findByRole("alert")).toHaveTextContent(/couldn't reach/i);
    expect(screen.getByRole("button", { name: "Sign in" })).toBeEnabled();
  });

  it("does not blame the password for it", async () => {
    // Two different problems, and telling somebody their password is wrong when the network is
    // down sends them off to reset a password that was fine.
    signInEmail.mockRejectedValue(new TypeError("Failed to fetch"));
    render(<LiveSignIn />);

    submit();

    expect((await screen.findByRole("alert")).textContent).not.toMatch(/password/i);
  });
});

describe("when it works", () => {
  it("leaves the button held down while the page is on its way out", async () => {
    // Re-enabling it first invites a second submission during the navigation.
    signInEmail.mockResolvedValue({ data: {} });
    render(<LiveSignIn />);

    submit();

    expect(await screen.findByRole("button", { name: "One moment…" })).toBeDisabled();
    expect(push).toHaveBeenCalledWith("/welcome");
  });
});

describe("the address bar", () => {
  it("follows the form to the other half", () => {
    render(<LiveSignIn />);

    fireEvent.click(screen.getByRole("button", { name: "Create one" }));

    expect(window.location.pathname).toBe("/sign-up");
    expect(screen.getByRole("heading", { level: 1, name: "Start a nap." })).toBeInTheDocument();
  });

  it("keeps what was already typed, since the switch is not a navigation", () => {
    render(<LiveSignIn />);
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "ada@example.com" } });

    fireEvent.click(screen.getByRole("button", { name: "Create one" }));

    expect(screen.getByLabelText("Email")).toHaveValue("ada@example.com");
  });
});

describe("the way in with no account", () => {
  it("is not offered until the server says it exists", async () => {
    // The right way round: a button that appears late beats one that disappears under a cursor,
    // and a demo link on a deployment that has closed that door leads nowhere.
    render(<LiveSignIn />);

    expect(screen.queryByRole("button", { name: "Try for free" })).toBeNull();
  });

  it("signs in anonymously and goes straight to work", async () => {
    // Not to `/welcome`: somebody who chose "without an account" has already answered the
    // question that page asks.
    ways.demo = true;
    signInAnonymous.mockResolvedValue({});
    render(<LiveSignIn />);

    fireEvent.click(await screen.findByRole("button", { name: "Try for free" }));

    await vi.waitFor(() => expect(push).toHaveBeenCalledWith("/dashboard"));
  });

  it("holds the free-trial button until the current session is known", async () => {
    ways.demo = true;
    useSession.mockReturnValue({ data: undefined, isPending: true });
    render(<LiveSignIn />);

    expect(await screen.findByRole("button", { name: "Try for free" })).toBeDisabled();
    expect(signInAnonymous).not.toHaveBeenCalled();
  });

  it("continues an existing free trial instead of attempting a second anonymous sign-in", async () => {
    ways.demo = true;
    useSession.mockReturnValue({ data: { user: { isAnonymous: true } }, isPending: false });
    render(<LiveSignIn />);

    await vi.waitFor(() => expect(replace).toHaveBeenCalledWith("/dashboard"));

    expect(signInAnonymous).not.toHaveBeenCalled();
  });

  it("says so and frees the button when the demo cannot be reached", async () => {
    // The same failure the email path documents: without this the button sits on "One moment…"
    // for as long as the page is open and nothing on screen says why.
    ways.demo = true;
    signInAnonymous.mockRejectedValue(new Error("offline"));
    render(<LiveSignIn />);

    fireEvent.click(await screen.findByRole("button", { name: "Try for free" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("couldn't reach the server");
    expect(push).not.toHaveBeenCalled();
  });
});

describe("when the browser accepts the sign-in and drops the cookie", () => {
  /*
   * Safari and Brave block third-party cookies outright, and the API is on a different site from
   * this app — so the request *succeeds*, the identity is created, and the browser silently
   * refuses to store what came back. Nothing on this page can see that: `result.error` is null,
   * so the old code redirected, and every request after it was a 401 that bounced straight back
   * here. To the person pressing the button, the app does nothing at all.
   *
   * Asking the server who we are is what turns that into something readable. A browser that kept
   * the cookie answers with a session; one that dropped it answers with nothing, which is the
   * condition itself rather than a guess from the user agent — and a guess is what this must not
   * be, since Brave fails this way while reporting itself as Chrome.
   */
  it("says why, rather than bouncing off the dashboard in silence", async () => {
    ways.demo = true;
    signInAnonymous.mockResolvedValue({});
    getSession.mockResolvedValue({ data: null });
    render(<LiveSignIn />);

    fireEvent.click(await screen.findByRole("button", { name: "Try for free" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/blocked/i);
    expect(push).not.toHaveBeenCalled();
  });

  it("names a way out that the person can actually take", async () => {
    // A message that only says "blocked" leaves somebody stuck on the page it happened on.
    ways.demo = true;
    signInAnonymous.mockResolvedValue({});
    getSession.mockResolvedValue({ data: null });
    render(<LiveSignIn />);

    fireEvent.click(await screen.findByRole("button", { name: "Try for free" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/chrome|firefox/i);
  });

  it("does not blame the credentials for it", async () => {
    // The same rule the unreachable-server case follows: this is not a rejected password, and
    // saying so sends somebody off to reset one that was fine.
    signInEmail.mockResolvedValue({});
    getSession.mockResolvedValue({ data: null });
    render(<LiveSignIn />);

    submit();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).not.toMatch(/password/i);
    expect(push).not.toHaveBeenCalled();
  });

  it("frees the button, since pressing it again is not the answer", async () => {
    ways.demo = true;
    signInAnonymous.mockResolvedValue({});
    getSession.mockResolvedValue({ data: null });
    render(<LiveSignIn />);

    fireEvent.click(await screen.findByRole("button", { name: "Try for free" }));

    await screen.findByRole("alert");
    expect(screen.getByRole("button", { name: "Try for free" })).toBeEnabled();
  });

  it("treats a check it could not make as a working sign-in", async () => {
    // The check is a guard against one specific browser behaviour, not a second gate on getting
    // in. A network blip while asking must not strand somebody whose cookie was stored fine —
    // if it really was dropped, the destination bounces them back here anyway.
    ways.demo = true;
    signInAnonymous.mockResolvedValue({});
    getSession.mockRejectedValue(new TypeError("Failed to fetch"));
    render(<LiveSignIn />);

    fireEvent.click(await screen.findByRole("button", { name: "Try for free" }));

    await vi.waitFor(() => expect(push).toHaveBeenCalledWith("/dashboard"));
  });
});

describe("the social buttons", () => {
  it("draws only what the server says it has, and sends the right provider", async () => {
    ways.socialProviders = ["google"];
    signInSocial.mockResolvedValue({});
    render(<LiveSignIn />);

    fireEvent.click(await screen.findByRole("button", { name: "Continue with Google" }));

    // Absolute, not `/welcome`: a relative callback is resolved against the *API's* origin,
    // which has no such page and answers the redirect with a JSON 404.
    expect(signInSocial).toHaveBeenCalledWith({
      provider: "google",
      callbackURL: "http://localhost:3000/welcome",
    });
    expect(screen.queryByRole("button", { name: "Continue with GitHub" })).toBeNull();
  });

  it("lands a new account on the key step rather than the dashboard", async () => {
    // The one moment where asking about a key is not an interruption of something else.
    signInEmail.mockResolvedValue({});
    render(<LiveSignIn />);

    submit();

    await vi.waitFor(() => expect(push).toHaveBeenCalledWith("/welcome"));
  });
});
