import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { z } from "zod";
import { prepareComputerLocalWeb } from "./computer-local-web.ts";

const owned: string[] = [];
afterEach(async () => {
  await Promise.all(owned.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "nap-local-web-test-"));
  owned.push(root);
  const source = join(root, "apps/web");
  const run = join(root, ".scratch/run");
  await mkdir(join(source, "src"), { recursive: true });
  await mkdir(join(source, "node_modules"));
  await mkdir(join(source, ".next"));
  await mkdir(run, { recursive: true });
  await writeFile(join(source, "src/page.tsx"), "export default function Page() { return null; }");
  await writeFile(
    join(source, "next.config.ts"),
    'export default {transpilePackages:["@nap/shared"]};',
  );
  await writeFile(join(source, "tsconfig.json"), '{"include":["src"]}');
  await writeFile(join(source, "package.json"), '{"name":"local-web"}');
  await writeFile(join(source, "postcss.config.mjs"), "export default {};");
  await writeFile(join(source, ".env.local"), "PRIVATE_FIXTURE=do-not-copy");
  await writeFile(join(source, ".next/sentinel"), "original server");
  return { root, source, run };
}

it("isolates the real web source and config while preserving the original build and secrets", async () => {
  const f = await fixture();
  const result = await prepareComputerLocalWeb({ repositoryRoot: f.root, runDirectory: f.run });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error.message);
  const { directory, close } = result.value;
  expect(directory).toBe(join(f.run, "web"));
  expect(await readFile(join(directory, "src/page.tsx"), "utf8")).toContain("Page");
  const config = z
    .object({ extends: z.string(), include: z.array(z.string()) })
    .parse(JSON.parse(await readFile(join(directory, "tsconfig.json"), "utf8")));
  expect(isAbsolute(config.extends)).toBe(false);
  expect(resolve(directory, config.extends)).toBe(join(f.source, "tsconfig.json"));
  expect(config.include).toEqual(["src", "next.config.ts"]);
  expect(await readFile(join(directory, "next.config.ts"), "utf8")).toBe(
    await readFile(join(f.source, "next.config.ts"), "utf8"),
  );
  await expect(stat(join(directory, "node_modules"))).resolves.toBeDefined();
  await expect(stat(join(directory, ".env.local"))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(stat(join(directory, ".next"))).rejects.toMatchObject({ code: "ENOENT" });
  await Promise.all([close(), close()]);
  await expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(join(f.source, ".next/sentinel"), "utf8")).toBe("original server");
});

it("refuses to overwrite an existing web directory and leaves it intact", async () => {
  const f = await fixture();
  const directory = join(f.run, "web");
  await mkdir(directory);
  await writeFile(join(directory, "sentinel"), "existing");
  expect((await prepareComputerLocalWeb({ repositoryRoot: f.root, runDirectory: f.run })).ok).toBe(
    false,
  );
  expect(await readFile(join(directory, "sentinel"), "utf8")).toBe("existing");
});

it("unwinds its newly created copy when required source configuration is absent", async () => {
  const f = await fixture();
  await rm(join(f.source, "next.config.ts"));
  expect((await prepareComputerLocalWeb({ repositoryRoot: f.root, runDirectory: f.run })).ok).toBe(
    false,
  );
  await expect(stat(join(f.run, "web"))).rejects.toMatchObject({ code: "ENOENT" });
});
