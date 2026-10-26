import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { DesktopScopes } from "./desktop-scopes.ts";

it("permanently closes delayed input and retains the original drain proof", () => {
  const directory = mkdtempSync(join(tmpdir(), "nap-scopes-"));
  try {
    const scopes = new DesktopScopes(directory);
    const scopeId = crypto.randomUUID();
    scopes.hold(scopeId, "ctrl+a");
    scopes.close(scopeId);
    expect(new DesktopScopes(directory).closed(scopeId)).toBe(true);
    expect(scopes.proof(scopeId, "box")).toBeUndefined();
    scopes.drained(scopeId, "box");
    const proof = new DesktopScopes(directory).proof(scopeId, "box");
    expect(proof).toEqual({ protocol: 2, kind: "scope_drained", scopeId, sandboxId: "box" });
    scopes.close(scopeId);
    expect(scopes.proof(scopeId, "box")).toEqual(proof);
    expect(scopes.proof(scopeId, "other")).toBeUndefined();
    expect(scopes.closed(scopeId)).toBe(true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
