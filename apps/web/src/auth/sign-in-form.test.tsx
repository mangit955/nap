import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SignInForm, type SignInFormProps } from "./sign-in-form.tsx";

/**
 * Queried by role and accessible name throughout, like every other component test here — a
 * form whose fields have no reachable label is a form a screen reader cannot fill in, and that
 * is worth failing on rather than working around with a test id.
 */

function setup(overrides: Partial<SignInFormProps> = {}) {
  const props: SignInFormProps = {
    mode: "sign-in",
    onModeChange: vi.fn(),
    onSubmit: vi.fn(),
    onSocial: vi.fn(),
    onDemo: vi.fn(),
    socialProviders: ["google", "github"],
    demoEnabled: true,
    ...overrides,
  };
  render(<SignInForm {...props} />);
  return props;
}

function type(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

function click(name: string) {
  fireEvent.click(screen.getByRole("button", { name }));
}

describe("what the page says it is", () => {
  it("names the half you are on, in each mode", () => {
    // The two arrivals are different people — one has an account and one does not — and a form
    // that says the same thing to both is one they have to read the button to understand.
    const { unmount } = render(
      <SignInForm
        mode="sign-in"
        onModeChange={vi.fn()}
        onSubmit={vi.fn()}
        onSocial={vi.fn()}
        onDemo={vi.fn()}
        socialProviders={[]}
        demoEnabled={false}
      />,
    );
    expect(screen.getByRole("heading", { level: 1, name: "Welcome back." })).toBeInTheDocument();
    expect(screen.getByText("Your apps are where you left them.")).toBeInTheDocument();
    unmount();

    setup({ mode: "sign-up" });
    expect(screen.getByRole("heading", { level: 1, name: "Start a nap." })).toBeInTheDocument();
  });

  it("offers a way back out", () => {
    // An auth page reached by accident is a dead end without one, and the wordmark is the thing
    // people already expect to be a link home.
    setup();

    expect(screen.getByRole("link", { name: /^nap/ })).toHaveAttribute("href", "/");
  });
});

describe("signing in", () => {
  it("hands over what was typed", () => {
    const props = setup();

    type("Email", "ada@example.com");
    type("Password", "a good password");
    click("Sign in");

    expect(props.onSubmit).toHaveBeenCalledWith({
      email: "ada@example.com",
      password: "a good password",
      name: "",
    });
  });

  it("asks for no name, because an existing account already has one", () => {
    setup();

    expect(screen.queryByLabelText("Name")).toBeNull();
  });
});

describe("signing up", () => {
  it("asks for a name as well, and sends it", () => {
    const props = setup({ mode: "sign-up" });

    type("Name", "Ada");
    type("Email", "ada@example.com");
    type("Password", "a good password");
    click("Create account");

    expect(props.onSubmit).toHaveBeenCalledWith({
      email: "ada@example.com",
      password: "a good password",
      name: "Ada",
    });
  });

  it("offers the other mode, since a person arrives wanting one of exactly two", () => {
    const props = setup({ mode: "sign-up" });

    click("Sign in");

    expect(props.onModeChange).toHaveBeenCalledWith("sign-in");
  });
});

describe("the social providers", () => {
  it.each([
    ["google", "Continue with Google"],
    ["github", "Continue with GitHub"],
  ] as const)("offers %s when the API has an app configured", (provider, label) => {
    const props = setup({ socialProviders: [provider] });

    click(label);

    // Named rather than just called: two buttons calling one handler with no argument would
    // send everybody to whichever provider the handler happened to hard-code.
    expect(props.onSocial).toHaveBeenCalledWith(provider);
  });

  it("offers neither when neither is configured", () => {
    // A button that looks fine and dies at the redirect back is the failure the whole
    // paired-credentials rule exists to prevent; not drawing it is the other half.
    setup({ socialProviders: [] });

    expect(screen.queryByRole("button", { name: "Continue with GitHub" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Continue with Google" })).toBeNull();
  });

  it("draws only the one that is configured", () => {
    setup({ socialProviders: ["google"] });

    expect(screen.getByRole("button", { name: "Continue with Google" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Continue with GitHub" })).toBeNull();
  });

  it("keeps a fixed order rather than following the API's", () => {
    // A menu that reorders itself between deployments is one nobody builds muscle memory for.
    setup({ socialProviders: ["github", "google"] });

    // The accessible name, not `textContent`: these buttons are a logo and nothing else, so
    // their text content is empty and an assertion on it would pass on two blank strings.
    const labels = screen
      .getAllByRole("button", { name: /^Continue with/ })
      .map((button) => button.getAttribute("aria-label"));
    expect(labels).toEqual(["Continue with Google", "Continue with GitHub"]);
  });

  it("says who it is for a screen reader, since the mark is all there is to see", () => {
    // The cost of dropping the words: an unlabelled icon button is announced as "button", and
    // two of them are two identical buttons with no way to tell which is which.
    setup({ socialProviders: ["github"] });

    const button = screen.getByRole("button", { name: "Continue with GitHub" });
    expect(button).toHaveTextContent("");
    // A pointer gets the same sentence a screen reader does.
    expect(button).toHaveAttribute("title", "Continue with GitHub");
  });
});

describe("the way in with no account", () => {
  it("is offered when the deployment allows it", () => {
    const props = setup({ demoEnabled: true });

    click("Try for free");

    expect(props.onDemo).toHaveBeenCalled();
  });

  it("says what it costs, so nobody meets a greyed-out picker unprepared", () => {
    setup({ demoEnabled: true });

    expect(screen.getByText(/free models/)).toBeInTheDocument();
  });

  it("is not offered when the deployment has closed that door", () => {
    setup({ demoEnabled: false });

    expect(screen.queryByRole("button", { name: "Try for free" })).toBeNull();
  });
});

describe("when something goes wrong", () => {
  it("says so in words, where a screen reader will announce it", () => {
    setup({ error: "That email and password do not match." });

    // `alert` rather than any visible-only treatment: this appears in response to something
    // the user just pressed, and is the only thing on the screen worth reading.
    expect(screen.getByRole("alert")).toHaveTextContent("That email and password do not match.");
  });

  it("holds the buttons still while a submission is in flight", () => {
    setup({ submitting: true });

    expect(screen.getByRole("button", { name: "One moment…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Continue with GitHub" })).toBeDisabled();
  });

  it("turns a ring beside the words while it waits", () => {
    // Reached by class, which this file otherwise never does: a spinner is decorative by
    // design — `aria-hidden`, no role, no name — so a role query is the one thing that cannot
    // see it. The same exception the doodle sheet below makes.
    //
    // The words are asserted by the accessible name, and both halves matter: without the ring
    // a stalled request looks identical to a fast one, and without the sentence there is
    // nothing for a screen reader to announce at the moment it needs to say "wait".
    setup({ submitting: true });

    const button = screen.getByRole("button", { name: "One moment…" });
    expect(button.querySelector(".nap-spin")).not.toBeNull();
  });
});

describe("the paper it is written on", () => {
  /**
   * Queried by test id and by counting elements, which the rest of this file never does — the
   * doodle sheet has no accessible surface *by design*, so a role query is the one thing that
   * cannot see it. The same exception the syntax highlighting makes; see `docs/GOTCHAS.md`
   * § Web and UI.
   */
  it("hangs a sheet of doodles behind the form, out of everyone's way", () => {
    setup();

    const wall = screen.getByTestId("doodle-wall");

    // Hidden from assistive technology and untouchable by the pointer. A full-screen layer over
    // the one form on the page is exactly the shape of thing that swallows a click, and a
    // hundred unlabelled drawings in the accessibility tree is a page nobody can navigate.
    expect(wall).toHaveAttribute("aria-hidden", "true");
    expect(wall.className).toContain("pointer-events-none");

    // A wall rather than a few marks: if the layout ever collapses to a handful of drawings the
    // page still looks intentional, which is why this is worth pinning to a number.
    expect(wall.querySelectorAll("svg").length).toBeGreaterThan(60);

    // And the form is still a form.
    expect(screen.getByRole("button", { name: "Sign in" })).toBeInTheDocument();
    expect(screen.getByLabelText("Email")).toBeInTheDocument();
  });
});
