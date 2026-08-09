import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CLAMP_LINES, OutputBlock } from "./output-block.tsx";

const lines = (count: number) =>
  Array.from({ length: count }, (_, i) => `line ${i + 1}`).join("\n");

describe("OutputBlock", () => {
  it("shows short output with nothing to expand", () => {
    render(<OutputBlock text={lines(3)} />);

    expect(screen.getByText(/line 3/)).toBeVisible();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("clamps long output and says how much is hidden", () => {
    // The number matters: "show more" leaves the reader guessing whether it is two lines or
    // two thousand, and a build log is usually the second.
    render(<OutputBlock text={lines(CLAMP_LINES + 84)} />);

    expect(screen.getByRole("button", { name: /84 more lines/ })).toBeInTheDocument();
  });

  it("keeps the newest lines when it clamps", () => {
    // Command output is read for how it ended — the error is at the bottom, not the top.
    render(<OutputBlock text={lines(CLAMP_LINES + 5)} />);

    expect(screen.getByText(new RegExp(`line ${CLAMP_LINES + 5}`))).toBeVisible();
    expect(screen.queryByText(/^line 1$/)).not.toBeInTheDocument();
  });

  it("reveals the rest when asked", () => {
    // `fireEvent` rather than user-event: this is one plain button, and the more faithful
    // library would be a dependency added for a single click.
    render(<OutputBlock text={lines(CLAMP_LINES + 5)} />);

    fireEvent.click(screen.getByRole("button", { name: /more lines/ }));

    expect(screen.getByText(/^line 1$/)).toBeVisible();
    expect(screen.getByRole("button", { name: /show less/i })).toBeInTheDocument();
  });

  it("renders nothing at all for empty output", () => {
    const { container } = render(<OutputBlock text="" />);

    expect(container).toBeEmptyDOMElement();
  });

  it("does not lose a trailing newline's worth of content", () => {
    render(<OutputBlock text={"only line\n"} />);

    expect(screen.getByText("only line")).toBeVisible();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
