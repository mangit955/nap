import type { FileListing } from "@nap/shared/files-protocol";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FileTreePane } from "./file-tree-pane.tsx";

const LISTING: FileListing = {
  ready: true,
  files: ["index.html", "package.json", "src/App.tsx", "src/components/Header.tsx"],
  truncated: false,
};

function show(props: Partial<Parameters<typeof FileTreePane>[0]> = {}) {
  return render(
    <FileTreePane
      listing={LISTING}
      status="ready"
      changed={new Set()}
      selected={undefined}
      onSelect={() => {}}
      {...props}
    />,
  );
}

/** The tree, found the way a screen reader finds it. */
const tree = () => within(screen.getByRole("region", { name: "Files" }));

describe("the tree", () => {
  it("renders the project's structure, nested", () => {
    show();

    expect(tree().getByRole("button", { name: /src/ })).toBeInTheDocument();
    expect(tree().getByRole("button", { name: /index\.html/ })).toBeInTheDocument();
  });

  it("shows what is inside a directory", () => {
    // Directories start open: a generated project is a handful of files, and a tree that
    // hides all of them behind clicks shows the user nothing on the turn they most want it.
    show();

    expect(tree().getByRole("button", { name: /App\.tsx/ })).toBeInTheDocument();
    expect(tree().getByRole("button", { name: /Header\.tsx/ })).toBeInTheDocument();
  });

  it("hides a directory's contents when it is collapsed", () => {
    show();

    fireEvent.click(tree().getByRole("button", { name: /components/ }));

    expect(tree().queryByRole("button", { name: /Header\.tsx/ })).toBeNull();
    // Its parent is untouched — collapsing one folder must not close the tree.
    expect(tree().getByRole("button", { name: /App\.tsx/ })).toBeInTheDocument();
  });

  it("asks for the file that was clicked", () => {
    const onSelect = vi.fn();
    show({ onSelect });

    fireEvent.click(tree().getByRole("button", { name: /App\.tsx/ }));

    expect(onSelect).toHaveBeenCalledWith("src/App.tsx");
  });

  it("does not treat a directory as a file to open", () => {
    const onSelect = vi.fn();
    show({ onSelect });

    fireEvent.click(tree().getByRole("button", { name: /components/ }));

    expect(onSelect).not.toHaveBeenCalled();
  });
});

describe("files the agent touched", () => {
  it("marks a changed file", () => {
    show({ changed: new Set(["src/App.tsx"]) });

    // In words, not only in colour — the same rule the transcript follows for a failed step.
    expect(tree().getByRole("button", { name: /App\.tsx.*changed/i })).toBeInTheDocument();
  });

  it("leaves everything else unmarked", () => {
    show({ changed: new Set(["src/App.tsx"]) });

    expect(tree().queryByRole("button", { name: /Header\.tsx.*changed/i })).toBeNull();
  });

  it("reveals a changed file inside a folder the user collapsed", () => {
    // The point of marking a file is that the user sees it happen. A mark inside a closed
    // folder is a mark nobody reads.
    const { rerender } = show();

    fireEvent.click(tree().getByRole("button", { name: /components/ }));
    expect(tree().queryByRole("button", { name: /Header\.tsx/ })).toBeNull();

    rerender(
      <FileTreePane
        listing={LISTING}
        status="ready"
        changed={new Set(["src/components/Header.tsx"])}
        selected={undefined}
        onSelect={() => {}}
      />,
    );

    expect(tree().getByRole("button", { name: /Header\.tsx/ })).toBeInTheDocument();
  });
});

describe("everything that is not a tree", () => {
  it("invites a first prompt when the project has no sandbox yet", () => {
    show({ listing: { ready: false, files: [], truncated: false } });

    expect(tree().getByText(/appear here/i)).toBeInTheDocument();
  });

  it("says a put-away project is put away, not new", () => {
    // The same "no sandbox" answer from the server means two opposite things: a project
    // nobody has typed into yet, and one with a year of work in a snapshot. Telling somebody
    // their files "appear here" when they already exist reads as having lost them.
    show({ listing: { ready: false, files: [], truncated: false }, putAway: true });

    expect(tree().getByText(/put away/i)).toBeInTheDocument();
    expect(tree().queryByText(/appear here/i)).not.toBeInTheDocument();
  });

  it("says an empty project is empty rather than broken", () => {
    show({ listing: { ready: true, files: [], truncated: false } });

    expect(tree().getByText(/no files/i)).toBeInTheDocument();
  });

  it("reports a listing it could not load", () => {
    show({ listing: undefined, status: "error" });

    expect(tree().getByText(/couldn't read/i)).toBeInTheDocument();
  });

  it("says when it is showing only part of a large project", () => {
    show({ listing: { ...LISTING, truncated: true } });

    expect(tree().getByText(/some files are not shown/i)).toBeInTheDocument();
  });
});
