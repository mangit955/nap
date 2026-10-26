import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { prepareDesktopTemplate, validateDesktopTemplate } from "./desktop-template.ts";

const roots: string[] = [];
function workspace() {
  const path = mkdtempSync(join(tmpdir(), "nap-template-"));
  roots.push(path);
  return path;
}
afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});
it("prepares a real standalone driver and starter app without publishing or copying local secrets", () => {
  const root = workspace();
  const source = join(root, "source");
  cpSync(fileURLToPath(new URL("../template", import.meta.url)), source, { recursive: true });
  mkdirSync(join(source, "node_modules"), { recursive: true });
  writeFileSync(join(source, "node_modules/private"), "ignored");
  writeFileSync(join(source, ".env"), "SECRET=never-publish");
  const directory = join(root, "prepared");
  const result = prepareDesktopTemplate({ directory, sourceDirectory: source });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value).toMatchObject({
    version: 1,
    template: "nap-vite-react",
    cpuCount: 2,
    memoryMB: 1024,
  });
  expect(existsSync(join(directory, "app/.env"))).toBe(false);
  expect(existsSync(join(directory, "app/node_modules"))).toBe(false);
  const driver = spawnSync("node", [join(directory, "desktop/driver.mjs")], { encoding: "utf8" });
  expect(driver.status).toBe(0);
  expect(JSON.parse(driver.stdout)).toMatchObject({ protocol: 2 });
  expect(validateDesktopTemplate(directory)).toEqual(result);
});
it.each(["tampered", "extra", "missing"])(
  "rejects %s prepared assets before publication",
  (mode) => {
    const directory = workspace();
    expect(prepareDesktopTemplate({ directory }).ok).toBe(true);
    if (mode === "tampered") writeFileSync(join(directory, "desktop/start-desktop.sh"), "changed");
    if (mode === "extra") writeFileSync(join(directory, "private.env"), "must not upload");
    if (mode === "missing") rmSync(join(directory, "desktop/driver.mjs"));
    expect(validateDesktopTemplate(directory)).toMatchObject({ ok: false });
  },
);
it("refuses to overwrite a nonempty preparation directory", () => {
  const directory = workspace();
  writeFileSync(join(directory, "keep"), "original");
  expect(prepareDesktopTemplate({ directory })).toMatchObject({ ok: false });
  expect(readFileSync(join(directory, "keep"), "utf8")).toBe("original");
});
