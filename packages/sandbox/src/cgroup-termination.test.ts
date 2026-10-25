import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { waitForCgroupEmpty } from "./cgroup-termination.ts";

describe("cgroup termination receipt", () => {
  it("waits for kernel-reported emptiness instead of equating a kill request with exit", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nap-cgroup-state-"));
    try {
      await writeFile(join(directory, "cgroup.events"), "populated 1\nfrozen 0\n");
      const emptied = waitForCgroupEmpty(directory, 1000);
      await new Promise((resolve) => setTimeout(resolve, 25));
      await writeFile(join(directory, "next.events"), "populated 0\nfrozen 0\n");
      await rename(join(directory, "next.events"), join(directory, "cgroup.events"));
      expect(await emptied).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("cannot certify a populated, missing, or malformed state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nap-cgroup-state-"));
    try {
      expect(await waitForCgroupEmpty(directory, 20)).toBe(false);
      for (const state of ["populated 1\n", "", "frozen 0\n", "populated 0\npopulated 1\n"]) {
        await writeFile(join(directory, "cgroup.events"), state);
        expect(await waitForCgroupEmpty(directory, 20)).toBe(false);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
