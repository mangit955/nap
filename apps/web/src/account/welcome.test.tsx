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

const state = vi.hoisted(() => ({ key: undefined as unknown, loaded: true, save: vi.fn() }));
vi.mock("./use-api-key.ts", () => ({
  useApiKey: () => ({
    state: state.key,
    loaded: state.loaded,
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
  state.loaded = true;
  state.save = vi.fn(async () => true);
  localStorage.clear();
});

describe("what it asks", () => {
  it("explains model billing and deployment-dependent free access", () => {
    render(<Welcome />);

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("API key");
    expect(screen.getByText(/only when this deployment offers a free tier/)).toBeInTheDocument();
  });

  it("offers the way past it", () => {
    render(<Welcome />);

    expect(screen.getByRole("button", { name: "Continue to dashboard" })).toBeInTheDocument();
  });
});

describe("how it is drawn", () => {
  it("wears the sign-up page's voice and gives the key form a dark ramp", () => {
    // Asserted by class because neither failure has an accessible surface. Without `.landing`
    // and `.lp-serif` the page loses sign-up's ground and faces, and somebody meets a third
    // style in their first minute. Without `.ai-stage-dark` the form's `--s-*` variables
    // resolve to nothing and it draws with no fill, no border and inherited text.
    render(<Welcome />);

    expect(screen.getByRole("main").parentElement).toHaveClass("landing");
    expect(screen.getByRole("heading", { level: 1 })).toHaveClass("lp-serif");
    expect(screen.getByLabelText("API key").closest(".ai-stage-dark")).not.toBeNull();
  });
});

describe("skipping", () => {
  it("goes to the dashboard and remembers, so it is a first-run step", () => {
    render(<Welcome />);

    screen.getByRole("button", { name: "Continue to dashboard" }).click();

    expect(push).toHaveBeenCalledWith("/dashboard");
    expect(hasSkippedWelcome()).toBe(true);
  });

  it("is remembered, so the question is not asked again on the next sign-in", async () => {
    // The flag was written and never read, which made "Continue to dashboard" an answer this page
    // forgot the moment it was given — and every sign-in afterwards asked again.
    localStorage.setItem("nap.welcome.skipped", "true");

    render(<Welcome />);

    await waitFor(() => expect(replace).toHaveBeenCalledWith("/dashboard"));
    expect(screen.queryByLabelText("API key")).toBeNull();
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

  it("is never shown the form on the way past", async () => {
    // The bug this page had: it drew the paste form while the answer was in flight, so somebody
    // who saved a key long ago was asked for it again and then yanked to the dashboard when the
    // answer landed. Being asked a question you have already answered is a worse first second
    // than a moment of nothing.
    state.key = { configured: true, platform: "openrouter", hint: "sk-or-…4f2a" };

    render(<Welcome />);

    expect(screen.queryByLabelText("API key")).toBeNull();
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/dashboard"));
  });
});

describe("while it does not yet know", () => {
  it("waits on a loader rather than guessing", () => {
    state.loaded = false;
    state.key = undefined;

    render(<Welcome />);

    expect(screen.getByRole("status")).toBeInTheDocument();
    expect(screen.queryByLabelText("API key")).toBeNull();
  });

  it("draws the form once asking has finished, even with nothing to show for it", () => {
    // The failure the `loaded` flag exists for: a server that could not be reached leaves the
    // state undefined, which is the same value it holds mid-flight. Waiting on that alone would
    // strand somebody on a spinner with no way to paste the key they came here to paste.
    state.loaded = true;
    state.key = undefined;

    render(<Welcome />);

    expect(screen.getByLabelText("API key")).toBeInTheDocument();
    expect(screen.queryByRole("status")).toBeNull();
  });
});
