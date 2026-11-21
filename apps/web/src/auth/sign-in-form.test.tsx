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

  it("keeps their row's place, empty, while the API has not said which there are", () => {
    // Drawn above the email form, a row that arrives late pushes Email down under a thumb that
    // was already on its way to it. Empty and unannounced until there is something to offer.
    setup({ socialProviders: [], socialPending: true });

    const held = screen.getByTestId("providers-pending");
    expect(held).toHaveAttribute("aria-hidden", "true");
    expect(held.parentElement?.children).toHaveLength(2);
    expect(screen.queryByRole("button", { name: /^Continue with/ })).toBeNull();
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

    // The accessible name, which is the whole sentence; the text drawn is only the brand.
    const labels = screen
      .getAllByRole("button", { name: /^Continue with/ })
      .map((button) => button.getAttribute("aria-label"));
    expect(labels).toEqual(["Continue with Google", "Continue with GitHub"]);
  });

  it("shows the provider's name, inside the sentence a screen reader hears", () => {
    // The visible word has to be part of the spoken name, or somebody driving the page by voice
    // says "GitHub" and nothing answers.
    setup({ socialProviders: ["github"] });

    const button = screen.getByRole("button", { name: "Continue with GitHub" });
    expect(button).toHaveTextContent("GitHub");
  });
});

describe("the way in with no account", () => {
  it("is offered when the deployment allows it", () => {
    const props = setup({ demoEnabled: true });

    click("try it without an account");

    expect(props.onDemo).toHaveBeenCalled();
  });

  it("is not offered when the deployment has closed that door", () => {
    setup({ demoEnabled: false });

    expect(screen.queryByRole("button", { name: "try it without an account" })).toBeNull();
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
    // see it.
    //
    // The words are asserted by the accessible name, and both halves matter: without the ring
    // a stalled request looks identical to a fast one, and without the sentence there is
    // nothing for a screen reader to announce at the moment it needs to say "wait".
    setup({ submitting: true });

    const button = screen.getByRole("button", { name: "One moment…" });
    expect(button.querySelector(".nap-spin")).not.toBeNull();
  });
});

describe("the page around the form", () => {
  it("names each field without drawing a label over it", () => {
    // The placeholder is the only name a sighted person sees; the hidden label is the one a
    // screen reader and a password manager read. Both have to say the same thing.
    setup({ mode: "sign-up" });

    for (const field of ["Name", "Email", "Password"]) {
      expect(screen.getByLabelText(field)).toBe(screen.getByPlaceholderText(field));
    }
  });

  it("keeps a focus outline for forced colours on every field", () => {
    // Read from the class list because jsdom has no forced-colors mode to render. The fields'
    // focus is a border colour, which High Contrast repaints away; `outline-none` would leave
    // them with no focus indicator there at all, where `outline-hidden` restores one.
    setup({ mode: "sign-up" });

    for (const field of ["Name", "Email", "Password"]) {
      const classes = screen.getByLabelText(field).className.split(/\s+/);
      expect(classes).toContain("outline-hidden");
      expect(classes).not.toContain("outline-none");
    }
  });

  it("offers the other mode exactly once, wherever the layout puts it", () => {
    // It sits top right on a wide screen and under the form on a phone. Drawing it twice and
    // hiding one would leave a screen reader with two "Sign in" buttons on a sign-up page, and
    // with the submit button that is three things saying sign in.
    setup({ mode: "sign-up" });

    expect(screen.getAllByRole("button", { name: "Sign in" })).toHaveLength(1);
  });

  it("keeps the photograph and its line out of the accessibility tree", () => {
    // Decoration repeating the front page's own line. `getByText` walks into `aria-hidden`
    // subtrees, so the assertion is on the ancestor rather than on the text's absence.
    setup();

    const line = screen.getByText("Then go take a nap.");
    expect(line.closest("[aria-hidden='true']")).not.toBeNull();
    expect(screen.getByRole("link", { name: /back to the front page/i })).toHaveAttribute(
      "href",
      "/",
    );
  });
});
