import type { FileContent } from "@nap/shared/files-protocol";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FileViewer } from "./file-viewer.tsx";

const SOURCE = `export function App() {\n  const [count, setCount] = useState(0);\n  return null;\n}\n`;

function file(overrides: Partial<FileContent> = {}): FileContent {
  return {
    path: "src/App.tsx",
    contents: SOURCE,
    truncated: false,
    bytes: SOURCE.length,
    ...overrides,
  };
}

function open(props: Partial<Parameters<typeof FileViewer>[0]> = {}) {
  return render(
    <FileViewer path="src/App.tsx" file={file()} status="ready" onClose={() => {}} {...props} />,
  );
}

describe("FileViewer", () => {
  it("is a dialog named after the file", () => {
    open();

    expect(screen.getByRole("dialog", { name: /src\/App\.tsx/ })).toBeInTheDocument();
  });

  it("renders the file's contents", () => {
    open();

    const source = screen.getByRole("dialog").textContent ?? "";
    expect(source).toContain("export function App() {");
    expect(source).toContain("const [count, setCount] = useState(0);");
  });

  it("numbers each line, beside the line it belongs to", () => {
    // Not just "a 2 appears somewhere": a number rendered away from its line is worse than no
    // numbers, and highlighting splits a line into a dozen spans, so the two have to be
    // checked together or neither is checked at all.
    open();

    const secondLine = screen.getByText("2").parentElement;

    expect(secondLine?.textContent).toContain("const [count, setCount] = useState(0);");
    expect(screen.getByText("4").parentElement?.textContent).toContain("}");
  });

  it("highlights the source", () => {
    // The one assertion here that cannot be made by role: highlighting has no accessible
    // surface at all — it is colour, and a screen reader is told nothing about it. Without
    // this, swapping the highlighter for a plain `<pre>` would break no test.
    const { container } = open();

    expect(container.querySelectorAll("span.token").length).toBeGreaterThan(0);
  });

  it("says when it is showing only part of a file", () => {
    open({ file: file({ truncated: true, bytes: 400_000 }) });

    expect(screen.getByText(/only the first part/i)).toBeInTheDocument();
    expect(screen.getByText(/391 KB/)).toBeInTheDocument();
  });

  it("says nothing about size when the whole file is there", () => {
    open();

    expect(screen.queryByText(/only the first part/i)).not.toBeInTheDocument();
  });

  it("reports a file it could not load", () => {
    open({ file: undefined, status: "error" });

    expect(screen.getByText(/couldn't read/i)).toBeInTheDocument();
  });

  it("says it is loading before the contents arrive", () => {
    open({ file: undefined, status: "loading" });

    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });

  it("closes on the close button", () => {
    const onClose = vi.fn();
    open({ onClose });

    fireEvent.click(screen.getByRole("button", { name: /close/i }));

    expect(onClose).toHaveBeenCalledOnce();
  });

  it("closes on Escape", () => {
    // A panel over the app that only a small button dismisses is a trap for anyone on a
    // keyboard.
    const onClose = vi.fn();
    open({ onClose });

    fireEvent.keyDown(window, { key: "Escape" });

    expect(onClose).toHaveBeenCalledOnce();
  });

  it("renders a file whose language it does not know", () => {
    // An extension nobody taught Prism about must show the file, not an empty panel.
    open({ path: "notes.wat", file: file({ path: "notes.wat", contents: "(module)\n" }) });

    expect(screen.getByText(/\(module\)/)).toBeInTheDocument();
  });
});
