import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { DESKTOP_BUILD } from "./desktop-build.ts";
import { DESKTOP_INSTALL_COMMAND, DESKTOP_SOURCES, desktopBuild } from "./desktop-template.ts";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const roots: string[] = [];
afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});
function copyOfSources(): string {
  const copy = mkdtempSync(join(tmpdir(), "nap-desktop-build-"));
  roots.push(copy);
  for (const path of DESKTOP_SOURCES) {
    mkdirSync(dirname(join(copy, path)), { recursive: true });
    cpSync(join(root, path), join(copy, path));
  }
  return copy;
}

it("is the build this checkout's desktop sources produce", () => {
  // Failing here means the desktop changed. Set DESKTOP_BUILD to the received value, then
  // republish the template before deploying: docs/DEPLOY.md, "Computer capability rollout".
  expect(desktopBuild()).toBe(DESKTOP_BUILD);
});

it("covers every local module the driver bundle contains", () => {
  const directory = mkdtempSync(join(tmpdir(), "nap-desktop-bundle-"));
  roots.push(directory);
  const outfile = join(directory, "driver.mjs");
  const bundle = spawnSync(
    "bun",
    [
      "build",
      "packages/sandbox/scripts/desktop-driver.ts",
      "--target=node",
      "--format=esm",
      `--outfile=${outfile}`,
    ],
    { cwd: root, encoding: "utf8" },
  );
  expect(bundle.status).toBe(0);
  // An unminified bundle names each module it inlines in a `// <path>` line, relative to cwd.
  const modules = new Set(
    readFileSync(outfile, "utf8")
      .split("\n")
      .filter((line) => /^\/\/ packages\/.+\.ts$/.test(line))
      .map((line) => line.slice(3)),
  );
  expect(modules.size).toBeGreaterThan(0);
  expect([...modules].sort()).toEqual(DESKTOP_SOURCES.filter((path) => path.endsWith(".ts")));
});

it.each(DESKTOP_SOURCES)("changes when %s changes", (path) => {
  const copy = copyOfSources();
  const before = desktopBuild({ root: copy });
  writeFileSync(join(copy, path), `${readFileSync(join(copy, path), "utf8")}\n`);
  expect(desktopBuild({ root: copy })).not.toBe(before);
});

it("changes when the image's installed packages change", () => {
  expect(desktopBuild({ installCommand: `${DESKTOP_INSTALL_COMMAND} imagemagick` })).not.toBe(
    desktopBuild(),
  );
});

it("is the same for the same sources wherever they are", () => {
  expect(desktopBuild({ root: copyOfSources() })).toBe(desktopBuild());
});
