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
const signInEmail = vi.fn();
const signUpEmail = vi.fn();
const signInSocial = vi.fn();
const signInAnonymous = vi.fn();
/** What `/auth/providers` answers with, per test. */
const ways = { socialProviders: [] as string[], demo: false };

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh: vi.fn() }),
}));

vi.mock("./client.ts", () => ({
  AFTER_SIGN_IN: "/welcome",
  AFTER_DEMO_SIGN_IN: "/dashboard",
  authClient: {
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

    expect(screen.queryByRole("button", { name: "Try it without an account" })).toBeNull();
  });

  it("signs in anonymously and goes straight to work", async () => {
    // Not to `/welcome`: somebody who chose "without an account" has already answered the
    // question that page asks.
    ways.demo = true;
    signInAnonymous.mockResolvedValue({});
    render(<LiveSignIn />);

    fireEvent.click(await screen.findByRole("button", { name: "Try it without an account" }));

    await vi.waitFor(() => expect(push).toHaveBeenCalledWith("/dashboard"));
  });

  it("says so and frees the button when the demo cannot be reached", async () => {
    // The same failure the email path documents: without this the button sits on "One moment…"
    // for as long as the page is open and nothing on screen says why.
    ways.demo = true;
    signInAnonymous.mockRejectedValue(new Error("offline"));
    render(<LiveSignIn />);

    fireEvent.click(await screen.findByRole("button", { name: "Try it without an account" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("couldn't reach the server");
    expect(push).not.toHaveBeenCalled();
  });
});

describe("the social buttons", () => {
  it("draws only what the server says it has, and sends the right provider", async () => {
    ways.socialProviders = ["google"];
    signInSocial.mockResolvedValue({});
    render(<LiveSignIn />);

    fireEvent.click(await screen.findByRole("button", { name: "Continue with Google" }));

    expect(signInSocial).toHaveBeenCalledWith({ provider: "google", callbackURL: "/welcome" });
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
