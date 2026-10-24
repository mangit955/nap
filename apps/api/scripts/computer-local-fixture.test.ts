import { expect, it } from "vitest";
import { computerLocalAppSource } from "./computer-local-fixture.ts";

it("derives the buggy and fixed real App.tsx from one source with one save-handler difference", () => {
  const buggy = computerLocalAppSource("buggy");
  const fixed = computerLocalAppSource("fixed");
  expect(buggy).toContain("setNotes((saved) => saved);");
  expect(fixed).toContain("setNotes((saved) => [...saved, note]);");
  expect(
    buggy.replace("setNotes((saved) => saved);", "setNotes((saved) => [...saved, note]);"),
  ).toBe(fixed);
  expect(buggy).toContain("export default function App()");
  expect(buggy).toContain("useState<string[]>([])");
  expect(buggy).toContain('setDraft("")');
  expect(fixed).toContain('<li data-testid="saved-note" key={index}>{note}</li>');
  expect(fixed).toContain('<ul data-testid="saved-notes" aria-label="Saved notes">');
  expect(fixed).toContain('data-testid="notes-app"');
  expect(fixed).toContain('data-testid="note-input"');
  expect(fixed).toContain('data-testid="save-note"');
  expect(fixed).toContain("Scripted local demo");
  expect(fixed).not.toMatch(/https?:|fetch\(|localStorage|dangerouslySetInnerHTML/);
});
