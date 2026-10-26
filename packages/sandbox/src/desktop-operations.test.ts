import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { DesktopOperations } from "./desktop-operations.ts";

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return { ...original, renameSync: vi.fn(original.renameSync) };
});
const roots: string[] = [];
const id = "72a3e710-65bf-420e-8cea-d4aa8e0b2f7d";
const identity = { pid: 123, startTicks: "456" };
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "nap-ops-"));
  roots.push(directory);
  return { directory, operations: new DesktopOperations(directory) };
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
it("retains cancellation before dispatch so waiting physical input never starts later", () => {
  const { operations } = fixture();
  expect(operations.cancel(id)).toBeUndefined();
  expect(operations.claim(id, identity)).toBe(false);
  operations.complete(id);
  expect(operations.claim(id, identity)).toBe(false);
});
it("exposes the exact process identity when cancellation follows dispatch", () => {
  const { operations } = fixture();
  expect(operations.claim(id, identity)).toBe(true);
  expect(operations.cancel(id)).toEqual(identity);
  operations.complete(id);
  expect(operations.cancel(id)).toBeUndefined();
});
it("isolates IDs and rejects unsafe IDs and corrupted process records", () => {
  const { directory, operations } = fixture();
  expect(() => operations.claim("../bad", identity)).toThrow();
  operations.cancel(id);
  expect(operations.claim(crypto.randomUUID(), identity)).toBe(true);
  writeFileSync(join(directory, `${id}.json`), JSON.stringify({ pid: -1, startTicks: "bad" }));
  expect(() => operations.cancel(id)).toThrow();
});

it("detects cancellation in the gap between its first check and identity publication", () => {
  const { operations } = fixture();
  const rename = vi.mocked(renameSync).getMockImplementation();
  if (!rename) throw new Error("Missing native rename implementation.");
  vi.mocked(renameSync).mockImplementationOnce((from, to) => {
    rename(from, to);
    expect(operations.cancel(id)).toEqual(identity);
  });
  expect(operations.claim(id, identity)).toBe(false);
});
