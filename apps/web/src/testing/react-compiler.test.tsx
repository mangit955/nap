/**
 * The web suite runs components as React Compiler ships them.
 *
 * `next build` compiles every client component with `babel-plugin-react-compiler`, and compiled
 * code behaves differently from its source wherever a component breaks the Rules of React: a ref
 * read during render, or a prop mutated in place, keeps a stale value instead of failing. Vitest
 * transforms with its own plugins, so without the same compiler in `vitest.config.ts` every
 * component test here would pass against code that never reaches a browser.
 *
 * Next applies the compiler only to the browser bundle. Every file under `app/` is a server page
 * or layout and never reaches it, so the config leaves `app/` alone too; `/sign-up`'s test calls
 * its page as a plain async function, which a compiled component cannot survive outside a render.
 * A `"use client"` file under `app/` would ship compiled and be tested uncompiled, so none may exist.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import nextConfig from "../../next.config.ts";
import SignUpPage from "../app/sign-up/page.tsx";
import { ChangedFilesCard } from "../chat/changed-files-card.tsx";

const repoRoot = join(import.meta.dirname, "../../../..");
/** A read of the compiler's per-component cache (`$[0]`), which every compiled function makes. */
const COMPILED = /\$\[\d+\]/;

const ManifestSchema = z.object({
  devDependencies: z.record(z.string(), z.string()),
});

function compilerPin(manifest: string): string | undefined {
  const parsed = ManifestSchema.parse(JSON.parse(readFileSync(join(repoRoot, manifest), "utf8")));
  return parsed.devDependencies["babel-plugin-react-compiler"];
}

describe("React Compiler", () => {
  it("is on for the web app's build", () => {
    expect(nextConfig.reactCompiler).toBe(true);
  });

  it("compiles the client components this suite renders", () => {
    // Any compiled client component would do. If this one stops compiling, check it with the
    // compiler before suspecting the test config.
    expect(String(ChangedFilesCard), "ChangedFilesCard ran uncompiled").toMatch(COMPILED);
  });

  it("leaves server components under app/ as Next does", () => {
    expect(String(SignUpPage)).not.toMatch(COMPILED);
  });

  it("finds no client component under app/, where the tests leave code uncompiled", () => {
    const appDirectory = join(repoRoot, "apps/web/src/app");
    const clients = readdirSync(appDirectory, { recursive: true, encoding: "utf8" }).filter(
      (path) =>
        /\.tsx?$/.test(path) &&
        /^\s*["']use client["']/.test(readFileSync(join(appDirectory, path), "utf8")),
    );
    expect(clients).toEqual([]);
  });

  it("is the same release in the tests as in the build", () => {
    // The root copy is what `vitest.config.ts` resolves; the web app's is what `next build` loads.
    const root = compilerPin("package.json");
    expect(root).toMatch(/^\d+\.\d+\.\d+$/);
    expect(compilerPin("apps/web/package.json")).toBe(root);
  });
});
