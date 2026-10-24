import { cp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import type { Result } from "@nap/shared/result";

/** Next identifies running dev servers by app directory, independently of the requested port. */
export async function prepareComputerLocalWeb(options: {
  repositoryRoot: string;
  runDirectory: string;
}): Promise<Result<{ directory: string; close(): Promise<void> }, { message: string }>> {
  const source = join(options.repositoryRoot, "apps/web");
  const directory = join(options.runDirectory, "web");
  try {
    await mkdir(directory);
  } catch {
    return {
      ok: false,
      error: { message: "Local web directory already exists or is unavailable." },
    };
  }
  let closing: Promise<void> | undefined;
  const close = () => (closing ??= rm(directory, { recursive: true, force: true }));
  try {
    await cp(join(source, "src"), join(directory, "src"), { recursive: true });
    for (const name of ["public", "postcss.config.mjs", "postcss.config.js"]) {
      try {
        await cp(join(source, name), join(directory, name), { recursive: true });
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
    }
    await cp(join(source, "package.json"), join(directory, "package.json"));
    await cp(join(source, "next.config.ts"), join(directory, "next.config.ts"));
    await symlink(join(source, "node_modules"), join(directory, "node_modules"), "dir");
    // Turbopack treats absolute tsconfig extends as server imports; a relative path works.
    await writeFile(
      join(directory, "tsconfig.json"),
      JSON.stringify({
        extends: relative(directory, join(source, "tsconfig.json")).split("\\").join("/"),
        include: ["src", "next.config.ts"],
      }),
    );
    return { ok: true, value: { directory, close } };
  } catch {
    try {
      await close();
    } catch {
      return {
        ok: false,
        error: { message: `Could not remove failed local web copy: ${directory}` },
      };
    }
    return { ok: false, error: { message: "Could not prepare the isolated local web app." } };
  }
}
