/** Prepare locally first; publishing the reviewed manifest is an explicit paid operation. */
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadEnvFile } from "@nap/shared/env-file";
import { defaultBuildLogger, Template, waitForPort } from "e2b";
import {
  DESKTOP_INSTALL_COMMAND,
  prepareDesktopTemplate,
  validateDesktopTemplate,
} from "../src/desktop-template.ts";
import { NAP_TEMPLATE, TEMPLATE_DEV_PORT, TEMPLATE_WORKDIR } from "../src/template.ts";

const args = process.argv.slice(2);
if (args.includes("--prepare")) {
  if (args.includes("--real"))
    throw new Error("Prepare and paid publication are separate operations.");
  const directory = mkdtempSync(join(tmpdir(), "nap-desktop-template-"));
  const result = prepareDesktopTemplate({ directory });
  if (!result.ok) throw new Error(result.error.message);
  const manifestSha256 = createHash("sha256")
    .update(readFileSync(join(directory, "manifest.json")))
    .digest("hex");
  console.log(
    JSON.stringify({ real: false, prepared: directory, manifestSha256, ...result.value }),
  );
  process.exit(0);
}
if (!args.includes("--real")) {
  console.log(
    JSON.stringify({
      real: false,
      template: NAP_TEMPLATE,
      desktop: "lazy",
      cpuCount: 2,
      memoryMB: 1024,
      next: "--prepare",
    }),
  );
  process.exit(0);
}
if (!args.includes(`--confirm-template=${NAP_TEMPLATE}`))
  throw new Error(`Publication requires --confirm-template=${NAP_TEMPLATE}.`);
const prepared = args.find((arg) => arg.startsWith("--prepared="))?.slice(11);
const expected = args.find((arg) => arg.startsWith("--manifest-sha256="))?.slice(18);
if (!prepared || !expected || !/^[0-9a-f]{64}$/.test(expected))
  throw new Error(
    "Publication requires --prepared=<directory> and --manifest-sha256=<reviewed hash>.",
  );
const directory = resolve(prepared);
const result = validateDesktopTemplate(directory);
if (!result.ok) throw new Error(result.error.message);
const actual = createHash("sha256")
  .update(readFileSync(join(directory, "manifest.json")))
  .digest("hex");
if (actual !== expected) throw new Error("The prepared manifest does not match the reviewed hash.");
loadEnvFile(join(import.meta.dirname, "../../../apps/api/.env"), process.env);
if (!process.env.E2B_API_KEY) throw new Error("E2B_API_KEY is required.");
const installNode = [
  "curl -fsSL https://deb.nodesource.com/setup_24.x | bash -",
  "apt-get install -y nodejs",
  'for b in node npm npx; do [ -x "/usr/bin/$b" ] && ln -sf "/usr/bin/$b" "/usr/local/bin/$b"; done',
  "true",
].join(" && ");
const template = Template({
  fileContextPath: directory,
  fileIgnorePatterns: ["node_modules", "dist", ".git"],
})
  .fromBaseImage()
  .runCmd(installNode, { user: "root" })
  .runCmd("curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash", { user: "root" })
  .runCmd(DESKTOP_INSTALL_COMMAND, { user: "root" })
  .makeDir("/usr/local/lib/nap-desktop", { user: "root" })
  .copy("desktop/driver.mjs", "/usr/local/lib/nap-desktop/driver.mjs", { user: "root" })
  .copy("desktop/start-desktop.sh", "/usr/local/bin/nap-desktop-start", { user: "root" })
  .runCmd("chmod 755 /usr/local/bin/nap-desktop-start", { user: "root" })
  .makeDir(TEMPLATE_WORKDIR, { user: "user" })
  .setWorkdir(TEMPLATE_WORKDIR)
  .setUser("user")
  .copy("app/package.json", TEMPLATE_WORKDIR, { user: "user" })
  .runCmd("bun install", { user: "user" })
  .copy("app", TEMPLATE_WORKDIR, { user: "user" })
  .runCmd(
    'git init -b main && git add -A && git -c user.email=agent@nap.dev -c user.name=Nap commit -m "Initial commit"',
    { user: "user" },
  )
  .setStartCmd(`cd ${TEMPLATE_WORKDIR} && bun run dev`, waitForPort(TEMPLATE_DEV_PORT));
const built = await Template.build(template, NAP_TEMPLATE, {
  cpuCount: result.value.cpuCount,
  memoryMB: result.value.memoryMB,
  onBuildLogs: defaultBuildLogger(),
});
console.log(JSON.stringify({ ...built, manifestSha256: actual }));
