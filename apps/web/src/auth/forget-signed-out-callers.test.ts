import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Its own file, apart from `forget-signed-out.test.tsx`, because it reads the source: a component
 * test that reads the filesystem is skipped by the workspace's changed-files run unless listed in
 * `scripts/check-changed.ts`, and this needs no DOM.
 */

const SRC = resolve(new URL(import.meta.url).pathname, "../..");

describe("signing out", () => {
  it("calls forgetSignedOut in every file that does it", () => {
    // Read from source: a sign-out button that forgets to call this leaves a whole conversation
    // in memory for whoever signs in next in the same tab, and nothing on screen shows it.
    const files: string[] = [];
    const walk = (directory: string) => {
      for (const name of readdirSync(directory)) {
        const path = join(directory, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) files.push(path);
      }
    };
    walk(SRC);

    const signingOut = files.filter((path) => /\.signOut\(/.test(readFileSync(path, "utf8")));
    expect(signingOut.length).toBeGreaterThan(0);
    const forgetting = signingOut.filter((path) =>
      /forgetSignedOut\(/.test(readFileSync(path, "utf8")),
    );
    expect(forgetting.map((path) => relative(SRC, path))).toEqual(
      signingOut.map((path) => relative(SRC, path)),
    );
  });
});
