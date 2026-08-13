import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stashFirstPrompt } from "./first-prompt.ts";
import { useFirstPrompt } from "./use-first-prompt.ts";

// A `.tsx` even though there is no JSX worth speaking of: the filename is what routes a test to
// the project with a DOM, and a hook test named `.test.ts` runs in Node and fails on `document`.

const PROJECT = "3e0fbc41-6f5d-4a8e-ab9c-4d5e6f708192";
const SESSION = "2a3f8a24-6c1b-4e0e-9b6f-3a5c0a1d9e77";

function Probe({
  projectId,
  sessionId,
  submit,
}: {
  projectId: string | undefined;
  sessionId: string | undefined;
  submit: (message: string) => void;
}) {
  useFirstPrompt({ projectId, sessionId, submit });
  return null;
}

afterEach(() => {
  window.sessionStorage.clear();
});

describe("the first turn of a project made from the front page", () => {
  it("is sent once the session is known", () => {
    stashFirstPrompt(PROJECT, { text: "a habit tracker" });
    const submit = vi.fn();

    render(<Probe projectId={PROJECT} sessionId={SESSION} submit={submit} />);

    expect(submit).toHaveBeenCalledWith("a habit tracker", undefined);
  });

  it("is sent exactly once, however often the effect runs", () => {
    // Each extra send is a message the user did not write and a turn they did not ask to
    // pay for. Re-rendering is the ordinary case: events arrive and the tree updates.
    stashFirstPrompt(PROJECT, { text: "a habit tracker" });
    const submit = vi.fn();

    const view = render(<Probe projectId={PROJECT} sessionId={SESSION} submit={submit} />);
    view.rerender(<Probe projectId={PROJECT} sessionId={SESSION} submit={submit} />);
    view.unmount();
    render(<Probe projectId={PROJECT} sessionId={SESSION} submit={submit} />);

    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("waits for the session rather than dropping the prompt", () => {
    // The project's conversation is resolved from the server a moment after the page opens.
    stashFirstPrompt(PROJECT, { text: "a habit tracker" });
    const submit = vi.fn();

    const view = render(<Probe projectId={PROJECT} sessionId={undefined} submit={submit} />);
    expect(submit).not.toHaveBeenCalled();

    view.rerender(<Probe projectId={PROJECT} sessionId={SESSION} submit={submit} />);
    expect(submit).toHaveBeenCalledWith("a habit tracker", undefined);
  });

  it("sends nothing when the visitor simply opened an old project", () => {
    const submit = vi.fn();

    render(<Probe projectId={PROJECT} sessionId={SESSION} submit={submit} />);

    expect(submit).not.toHaveBeenCalled();
  });

  it("leaves another project's prompt for that project", () => {
    stashFirstPrompt("some-other-project", { text: "a habit tracker" });
    const submit = vi.fn();

    render(<Probe projectId={PROJECT} sessionId={SESSION} submit={submit} />);

    expect(submit).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem("nap.first-prompt")).not.toBeNull();
  });

  it("sends the dashboard model with the first turn", () => {
    stashFirstPrompt(PROJECT, { text: "a habit tracker", model: "anthropic/claude-opus-5" });
    const submit = vi.fn();

    render(<Probe projectId={PROJECT} sessionId={SESSION} submit={submit} />);

    expect(submit).toHaveBeenCalledWith("a habit tracker", "anthropic/claude-opus-5");
  });
});
