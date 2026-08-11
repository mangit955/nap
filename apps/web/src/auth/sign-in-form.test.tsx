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
    onGithub: vi.fn(),
    githubEnabled: true,
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

describe("GitHub", () => {
  it("is offered when the API has an app configured", () => {
    const props = setup({ githubEnabled: true });

    click("Continue with GitHub");

    expect(props.onGithub).toHaveBeenCalled();
  });

  it("is not offered when it is not configured", () => {
    // A button that looks fine and dies at the redirect back from GitHub is the failure the
    // whole paired-credentials rule exists to prevent; not drawing it is the other half.
    setup({ githubEnabled: false });

    expect(screen.queryByRole("button", { name: "Continue with GitHub" })).toBeNull();
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
});
