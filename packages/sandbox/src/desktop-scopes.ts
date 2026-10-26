import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type ScopeDrainProof,
  ScopeDrainProofSchema,
} from "@nap/shared/ports/desktop-input-transport";
import { z } from "zod";

/** Scope tombstones and lock inode survive for the sandbox lifetime. */
export class DesktopScopes {
  constructor(readonly directory: string) {}
  #path(scopeId: string): string {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    return join(this.directory, z.uuid().parse(scopeId));
  }
  close(scopeId: string): void {
    writeFileSync(`${this.#path(scopeId)}.closed`, "", { mode: 0o600 });
  }
  closed(scopeId: string): boolean {
    return existsSync(`${this.#path(scopeId)}.closed`);
  }
  hold(scopeId: string, chord: string): void {
    writeFileSync(`${this.#path(scopeId)}.keys`, JSON.stringify({ chord }), { mode: 0o600 });
  }
  proof(scopeId: string, sandboxId: string): ScopeDrainProof | undefined {
    const path = `${this.#path(scopeId)}.drained`;
    if (!existsSync(path)) return undefined;
    const proof = ScopeDrainProofSchema.parse(JSON.parse(readFileSync(path, "utf8")));
    return proof.sandboxId === sandboxId && proof.scopeId === scopeId ? proof : undefined;
  }
  drained(scopeId: string, sandboxId: string): ScopeDrainProof {
    const proof = ScopeDrainProofSchema.parse({
      protocol: 2,
      kind: "scope_drained",
      scopeId,
      sandboxId,
    });
    const path = this.#path(scopeId);
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(proof), { mode: 0o600 });
    renameSync(temporary, `${path}.drained`);
    return proof;
  }
}
