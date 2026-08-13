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

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh: vi.fn() }),
}));

vi.mock("./client.ts", () => ({
  AFTER_SIGN_IN: "/dashboard",
  authClient: {
    signIn: {
      email: (...args: unknown[]) => signInEmail(...args),
      social: (...args: unknown[]) => signInSocial(...args),
    },
    signUp: { email: (...args: unknown[]) => signUpEmail(...args) },
  },
}));

// The providers lookup is a real network call in an effect; left alone it reaches for a server
// that is not there and the test waits on the failure.
vi.mock("../api/credentialed-fetch.ts", () => ({
  credentialedFetch: () => Promise.resolve(new Response(JSON.stringify({ socialProviders: [] }))),
}));

const { LiveSignIn } = await import("./live-sign-in.tsx");

function submit(email = "ada@example.com", password = "a good password") {
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: email } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: password } });
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
}

beforeEach(() => {
  vi.clearAllMocks();
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
    expect(push).toHaveBeenCalledWith("/dashboard");
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
