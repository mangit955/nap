import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { hasSkippedWelcome, Welcome } from "./welcome.tsx";

/**
 * The step between signing up and working. Two things about it are load-bearing and both are
 * about *not* getting in the way: somebody who already has a key never sees it, and skipping is
 * a real answer rather than a way out of a form.
 */

const push = vi.fn();
const replace = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, replace }) }));

const state = vi.hoisted(() => ({ key: undefined as unknown, save: vi.fn() }));
vi.mock("./use-api-key.ts", () => ({
  useApiKey: () => ({
    state: state.key,
    error: undefined,
    busy: false,
    save: state.save,
    remove: vi.fn(),
  }),
}));

beforeEach(() => {
  push.mockClear();
  replace.mockClear();
  state.key = { configured: false };
  state.save = vi.fn(async () => true);
  localStorage.clear();
});

describe("what it asks", () => {
  it("says a key is optional and what it buys", () => {
    // Whoever lands here already has a working account. A page that implied otherwise would be
    // a toll booth with nothing behind it.
    render(<Welcome />);

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("optional");
    expect(screen.getByText(/free models/)).toBeInTheDocument();
  });

  it("offers the way past it", () => {
    render(<Welcome />);

    expect(screen.getByRole("button", { name: "Just try it free" })).toBeInTheDocument();
  });
});

describe("skipping", () => {
  it("goes to the dashboard and remembers, so it is a first-run step", () => {
    render(<Welcome />);

    screen.getByRole("button", { name: "Just try it free" }).click();

    expect(push).toHaveBeenCalledWith("/dashboard");
    expect(hasSkippedWelcome()).toBe(true);
  });
});

describe("somebody who already has a key", () => {
  it("is sent straight on rather than shown the form again", async () => {
    state.key = { configured: true, platform: "openrouter", hint: "sk-or-…4f2a" };

    render(<Welcome />);

    // `replace`, not `push`: this page must not sit in the history between the dashboard and
    // wherever they came from.
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/dashboard"));
  });

  it("is not sent anywhere while the answer is still in flight", async () => {
    // `undefined` is not "no key". Redirecting on it would bounce people off the page before
    // it was known whether they needed it.
    state.key = undefined;

    render(<Welcome />);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(replace).not.toHaveBeenCalled();
  });
});
