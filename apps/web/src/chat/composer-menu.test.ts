import { describe, expect, it } from "vitest";
import { applyPick, COMMANDS, type ComposerToken, menuRows, parseToken } from "./composer-menu.ts";

/**
 * A `.test.ts` under `apps/web`, like `transcript.test.ts` and `working-state.test.ts`: the
 * menu is a fold over a string, and none of the cases that matter need a DOM.
 */

const FILES = [
  "src/App.tsx",
  "src/Counter.tsx",
  "src/components/Header.tsx",
  "package.json",
  "index.html",
];

const token = (draft: string): ComposerToken => {
  const found = parseToken(draft);
  if (found === undefined) throw new Error(`expected a token in ${JSON.stringify(draft)}`);
  return found;
};

describe("parseToken", () => {
  it("finds nothing in ordinary prose", () => {
    expect(parseToken("add a counter")).toBeUndefined();
  });

  it("opens the file menu on a bare @", () => {
    expect(parseToken("@")).toMatchObject({ kind: "file", query: "", start: 0 });
  });

  it("opens the command menu on a bare /", () => {
    expect(parseToken("/")).toMatchObject({ kind: "command", query: "", start: 0 });
  });

  it("grows the query as it is typed", () => {
    expect(parseToken("@Coun")).toMatchObject({ kind: "file", query: "Coun" });
  });

  it("ignores an @ inside a word, so an email address is just text", () => {
    // The trigger has to follow a space or start the draft. Without that, typing an address
    // opens a file menu over the sentence somebody is in the middle of writing.
    expect(parseToken("mail me at ada@example.com")).toBeUndefined();
  });

  it("ignores a / inside a path already written out", () => {
    expect(parseToken("look at src/App.tsx")).toBeUndefined();
  });

  it("closes once the mention is followed by a space", () => {
    // A finished mention is not an open menu — otherwise the list stays up for the rest of
    // the sentence and Enter picks a row instead of sending.
    expect(parseToken("@src/App.tsx and")).toBeUndefined();
  });

  it("finds a trigger after words already typed, and says where it starts", () => {
    const found = token("change the colour in @App");
    expect(found).toMatchObject({ kind: "file", query: "App" });
    expect("change the colour in @App".slice(found.start)).toBe("@App");
  });
});

describe("menuRows", () => {
  it("offers every command for a bare slash", () => {
    expect(menuRows(token("/"), FILES)).toHaveLength(COMMANDS.length);
  });

  it("narrows commands as the query grows", () => {
    expect(menuRows(token("/fi"), FILES).map((row) => row.name)).toEqual(["/fix"]);
  });

  it("matches a file anywhere in its path, not only at the start", () => {
    // Every path here begins `src/`, so a prefix match would mean typing the directory first
    // to reach a file people think of by its name.
    expect(menuRows(token("@Counter"), FILES).map((row) => row.name)).toEqual(["src/Counter.tsx"]);
  });

  it("ignores case, because nobody types the capital", () => {
    expect(menuRows(token("@counter"), FILES).map((row) => row.name)).toEqual(["src/Counter.tsx"]);
  });

  it("shows the filename as the detail, since every path shares a prefix", () => {
    expect(menuRows(token("@Header"), FILES)[0]).toMatchObject({
      name: "src/components/Header.tsx",
      detail: "Header.tsx",
    });
  });

  it("caps the list so it cannot cover the transcript", () => {
    const many = Array.from({ length: 40 }, (_, i) => `src/File${i}.tsx`);
    expect(menuRows(token("@"), many)).toHaveLength(8);
  });

  it("offers nothing when a query matches no file", () => {
    expect(menuRows(token("@nothing-like-this"), FILES)).toEqual([]);
  });
});

describe("applyPick", () => {
  it("replaces the token and keeps what came before it", () => {
    const draft = "change the colour in @App";
    expect(applyPick(draft, token(draft), { key: "x", name: "src/App.tsx", detail: "" })).toBe(
      "change the colour in @src/App.tsx ",
    );
  });

  it("leaves a trailing space, so the caret is where the next word goes", () => {
    expect(applyPick("@", token("@"), { key: "x", name: "src/App.tsx", detail: "" })).toBe(
      "@src/App.tsx ",
    );
  });

  it("turns a command into the opening of a sentence rather than a bare verb", () => {
    // What reaches the model is English. "/fix" on its own is a prompt with no object.
    const row = COMMANDS.find((c) => c.key === "fix");
    if (row === undefined) throw new Error("expected a fix command");

    expect(applyPick("/fi", token("/fi"), row)).toBe("Fix the ");
  });

  it("keeps earlier text when a command is picked mid-draft", () => {
    const draft = "in the header, /re";
    const row = COMMANDS.find((c) => c.key === "restyle");
    if (row === undefined) throw new Error("expected a restyle command");

    expect(applyPick(draft, token(draft), row)).toBe("in the header, Restyle the ");
  });
});
