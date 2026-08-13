import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DashboardHero } from "./dashboard-hero.tsx";

/**
 * The greeting and the box under it — the one control this page exists for.
 *
 * The rim light around the box has no accessible surface and is checked by eye, not here; what
 * these assert is that the box behaves like the composer people already know from the workspace.
 */

function show(props: Partial<Parameters<typeof DashboardHero>[0]> = {}) {
  const handlers = { onChange: vi.fn(), onSubmit: vi.fn() };

  const view = render(
    <DashboardHero name="Manas" value="" busy={false} error={undefined} {...handlers} {...props} />,
  );

  return { ...handlers, view };
}

const box = () => screen.getByLabelText("Describe the app you want");

class FakeRecognition {
  static instances: FakeRecognition[] = [];
  continuous = false;
  interimResults = false;
  onresult: ((event: { resultIndex: number; results: ArrayLike<unknown> }) => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  start = vi.fn();
  stop = vi.fn();
  abort = vi.fn();

  constructor() {
    FakeRecognition.instances.push(this);
  }

  say(text: string, isFinal: boolean) {
    this.onresult?.({
      resultIndex: 0,
      results: [{ isFinal, 0: { transcript: text } }],
    });
  }
}

function installRecognition() {
  FakeRecognition.instances = [];
  Object.defineProperty(window, "SpeechRecognition", {
    configurable: true,
    value: FakeRecognition,
  });
}

afterEach(() => {
  delete (window as Window & { SpeechRecognition?: unknown }).SpeechRecognition;
  vi.useRealTimers();
});

describe("the dashboard hero", () => {
  const models = [
    { id: "openai/gpt-5.6-luna", label: "Gpt 5 6 Luna", free: false },
    { id: "anthropic/claude-opus-5", label: "Claude Opus 5", free: false },
  ];

  it("greets the person by name", () => {
    show();

    expect(screen.getByRole("heading", { name: /Manas/ })).toBeInTheDocument();
  });

  it("adds quiet Nap stickers around the otherwise empty prompt band", () => {
    show();

    expect(screen.getByTestId("nap-stickers")).toBeInTheDocument();
  });

  it("sends what was typed on Enter", () => {
    const { onSubmit } = show({ value: "a habit tracker" });

    fireEvent.keyDown(box(), { key: "Enter" });

    expect(onSubmit).toHaveBeenCalledWith("a habit tracker");
  });

  it("types an example into an empty prompt hint", () => {
    vi.useFakeTimers();
    show();

    act(() => vi.advanceTimersByTime(55));

    expect(box()).toHaveAttribute("placeholder", "Let's build a");
  });

  it("makes a newline on Shift+Enter instead", () => {
    // A prompt is usually a paragraph, and losing one to a stray Enter is what people stop
    // trusting an input over.
    const { onSubmit } = show({ value: "a habit tracker" });

    fireEvent.keyDown(box(), { key: "Enter", shiftKey: true });

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("sends nothing that is only whitespace", () => {
    const { onSubmit } = show({ value: "   " });

    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("cannot be sent twice while the last one is on its way", () => {
    const { onSubmit } = show({ value: "a habit tracker", busy: true });

    fireEvent.keyDown(box(), { key: "Enter" });

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  });

  it("puts an example in the box rather than sending it", () => {
    // A starting point, not a decision: people edit these before sending.
    const { onChange, onSubmit } = show({ prompts: ["a habit tracker with a weekly grid"] });

    fireEvent.click(screen.getByRole("button", { name: "a habit tracker with a weekly grid" }));

    expect(onChange).toHaveBeenCalledWith("a habit tracker with a weekly grid");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("says why nothing happened when the send failed", () => {
    show({ error: "you have too many projects open" });

    expect(screen.getByRole("alert")).toHaveTextContent("you have too many projects open");
  });

  it("shows the deployment fallback when there is a model choice", () => {
    show({ models, model: "anthropic/claude-opus-5" });

    expect(screen.getByRole("button", { name: "Model" })).toHaveTextContent("Claude Opus 5");
  });

  it("does not show a model control when there is no choice", () => {
    show({ models: [models[0]!], model: models[0]!.id });

    expect(screen.queryByRole("button", { name: "Model" })).toBeNull();
  });

  it("reports the model selected for the new project", () => {
    const onModelChange = vi.fn();
    show({ models, model: models[0]!.id, onModelChange });

    fireEvent.click(screen.getByRole("button", { name: "Model" }));
    fireEvent.click(screen.getByRole("button", { name: /Claude Opus 5/ }));

    expect(onModelChange).toHaveBeenCalledWith("anthropic/claude-opus-5");
  });

  it("hides dictation when the browser cannot recognize speech", () => {
    show();

    expect(screen.queryByRole("button", { name: "Start dictation" })).toBeNull();
  });

  it("shows interim dictation separately and appends finalized speech", () => {
    installRecognition();
    const { onChange } = show({ value: "build" });

    fireEvent.click(screen.getByRole("button", { name: "Start dictation" }));
    const recognition = FakeRecognition.instances[0]!;

    expect(recognition.start).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Stop dictation" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    act(() => recognition.say("a habit", false));
    expect(screen.getByText("a habit")).toBeInTheDocument();
    expect(box()).toHaveValue("build");

    act(() => recognition.say("a habit tracker", true));
    expect(onChange).toHaveBeenCalledWith("build a habit tracker");
  });

  it("stops dictation and explains denied microphone access", () => {
    installRecognition();
    show();

    fireEvent.click(screen.getByRole("button", { name: "Start dictation" }));
    act(() => FakeRecognition.instances[0]!.onerror?.({ error: "not-allowed" }));

    expect(screen.getByRole("alert")).toHaveTextContent("Microphone access was not granted.");
    expect(screen.getByRole("button", { name: "Start dictation" })).toBeInTheDocument();
  });
});
