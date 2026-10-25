import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** cgroup.kill requests termination; only the kernel's empty state proves it finished. */
export async function waitForCgroupEmpty(directory: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let state: string;
    try {
      state = await readFile(join(directory, "cgroup.events"), "utf8");
    } catch {
      return false;
    }
    const populated = [...state.matchAll(/^populated ([01])$/gm)];
    if (populated.length !== 1) return false;
    if (populated[0]?.[1] === "0") return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
