import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

const IdentitySchema = z.strictObject({ pid: z.int().positive(), startTicks: z.string().min(1) });
type Identity = z.infer<typeof IdentitySchema>;

/** A cancel arriving before flock grants the action is still a cancel. */
export class DesktopOperations {
  readonly #directory: string;
  constructor(directory: string) {
    this.#directory = directory;
  }
  #path(id: string): string {
    return join(this.#directory, z.uuid().parse(id));
  }
  claim(id: string, identity: Identity): boolean {
    const path = this.#path(id);
    const parsed = IdentitySchema.parse(identity);
    mkdirSync(this.#directory, { recursive: true, mode: 0o700 });
    if (existsSync(`${path}.cancelled`)) return false;
    const pending = `${path}.${process.pid}.tmp`;
    writeFileSync(pending, JSON.stringify(parsed), { mode: 0o600 });
    renameSync(pending, `${path}.json`);
    // Cancel writes its marker before reading our identity. Either it sees the identity,
    // or this second check sees the marker, including the gap around the atomic rename.
    return !existsSync(`${path}.cancelled`);
  }
  cancel(id: string): Identity | undefined {
    const path = this.#path(id);
    mkdirSync(this.#directory, { recursive: true, mode: 0o700 });
    writeFileSync(`${path}.cancelled`, "", { mode: 0o600 });
    try {
      return IdentitySchema.parse(JSON.parse(readFileSync(`${path}.json`, "utf8")));
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
      throw error;
    }
  }
  complete(id: string): void {
    rmSync(`${this.#path(id)}.json`, { force: true });
    // Markers last for this disposable VM. Removing one could resurrect a delayed dispatch.
  }
}
