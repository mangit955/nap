/** Free manual smoke. Never imports or calls the E2B builder. */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../../..");
const sourceRoot = resolve(process.env.NAP_CHROME_SOURCE_ROOT ?? root);
const expectedDriverBundleSha256 = z
  .string()
  .regex(/^[0-9a-f]{64}$/)
  .optional()
  .parse(process.env.NAP_CHROME_EXPECTED_DRIVER_SHA256);
const { DESKTOP_INSTALL_COMMAND } = z
  .object({ DESKTOP_INSTALL_COMMAND: z.string() })
  .parse(
    await import(pathToFileURL(join(sourceRoot, "packages/sandbox/src/desktop-template.ts")).href),
  );
const output = process.argv[2]
  ? resolve(process.argv[2])
  : mkdtempSync(join(tmpdir(), "nap-chrome-evidence-"));
const fault = z.enum(["typing", "policy", "dimensions"]).optional().parse(process.argv[3]);
mkdirSync(output, { recursive: true });
assert.equal(
  readdirSync(output).length,
  0,
  "Use an empty evidence directory to avoid mixing runs.",
);
const context = mkdtempSync(join(tmpdir(), "nap-chrome-smoke-"));
const name = `nap-chrome-smoke-${randomUUID()}`;
const image = `${name}:local`;
const version = "156.0.8078.47-1";
const sha256 = "6c92cd22e90c6e3e255d782991543fa2091db8614e8536a971a7433a5c4d7ac8";
const chromeUrl = `https://dl.google.com/linux/chrome/deb/pool/main/g/google-chrome-stable/google-chrome-stable_${version}_amd64.deb`;
const started = Date.now();
function run(command: string, args: string[], timeout = 30000, cwd = root) {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    timeout,
    killSignal: "SIGKILL",
    maxBuffer: 32_000_000,
  });
}
function cleanup() {
  for (const args of [
    ["rm", "-f", name],
    ["image", "rm", image],
  ]) {
    try {
      run("docker", args, 20000);
    } catch {}
  }
  rmSync(context, { recursive: true, force: true });
}
process.once("SIGINT", () => {
  cleanup();
  process.exit(130);
});
process.once("SIGTERM", () => {
  cleanup();
  process.exit(143);
});
try {
  // Keep the production dependency list and installation sequence; pin only Chrome's download.
  assert.ok(
    DESKTOP_INSTALL_COMMAND.includes(
      "https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb",
    ),
  );
  const install = DESKTOP_INSTALL_COMMAND.replace(
    "https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb",
    chromeUrl,
  ).replace(
    "apt-get install -y /tmp/nap-chrome.deb",
    `echo '${sha256}  /tmp/nap-chrome.deb' | sha256sum -c - && apt-get install -y /tmp/nap-chrome.deb`,
  );
  writeFileSync(join(context, "install.sh"), `set -euo pipefail\n${install}\n`);
  for (const [source, target] of [
    [join(sourceRoot, "packages/sandbox/scripts/desktop-driver.ts"), "driver.mjs"],
    ["packages/sandbox/scripts/desktop-chrome-smoke/smoke.ts", "smoke.mjs"],
    ["packages/sandbox/scripts/desktop-chrome-smoke/fixture.ts", "fixture.mjs"],
  ]) {
    assert.ok(source && target);
    run(
      "bun",
      ["build", source, "--target=node", "--format=esm", `--outfile=${join(context, target)}`],
      30000,
      target === "driver.mjs" ? sourceRoot : root,
    );
  }
  cpSync(
    join(sourceRoot, "packages/sandbox/desktop/start-desktop.sh"),
    join(context, "start-desktop.sh"),
  );
  if (fault === "policy") {
    const path = join(context, "start-desktop.sh");
    const source = readFileSync(path, "utf8");
    const broken = source.replace(
      '"URLBlocklist":["*","chrome://*","file://*"]',
      '"URLBlocklist":[]',
    );
    assert.notEqual(source, broken);
    writeFileSync(path, broken);
  }
  cpSync(join(here, "Dockerfile"), join(context, "Dockerfile"));
  console.log("Building local linux/amd64 image. Build deadline: 15 minutes.");
  const build = spawnSync(
    "docker",
    ["build", "--progress=plain", "--platform", "linux/amd64", "-t", image, context],
    {
      encoding: "utf8",
      timeout: 900000,
      killSignal: "SIGKILL",
      maxBuffer: 32_000_000,
    },
  );
  writeFileSync(join(output, "build.log"), `${build.stdout ?? ""}${build.stderr ?? ""}`);
  assert.equal(
    build.status,
    0,
    `Docker build failed. Read ${join(output, "build.log")}. ${build.error ?? ""}`,
  );
  const buildMs = Date.now() - started;
  const driverBundleSha256 = createHash("sha256")
    .update(readFileSync(join(context, "driver.mjs")))
    .digest("hex");
  const provenance = {
    sourceRoot,
    sourceCommit: run("git", ["rev-parse", "HEAD"], 30000, sourceRoot).trim(),
    sourceDirty: run("git", ["status", "--porcelain"], 30000, sourceRoot).trim(),
    chromePackageVersion: version,
    chromeUrl,
    chromeDebSha256: sha256,
    fault: fault ?? null,
    installCommand: DESKTOP_INSTALL_COMMAND,
    startupSha256: createHash("sha256")
      .update(readFileSync(join(context, "start-desktop.sh")))
      .digest("hex"),
    driverBundleSha256,
    smokeBundleSha256: createHash("sha256")
      .update(readFileSync(join(context, "smoke.mjs")))
      .digest("hex"),
    fixtureBundleSha256: createHash("sha256")
      .update(readFileSync(join(context, "fixture.mjs")))
      .digest("hex"),
    runnerSourceSha256: createHash("sha256")
      .update(readFileSync(fileURLToPath(import.meta.url)))
      .digest("hex"),
    expectedDriverBundleSha256: expectedDriverBundleSha256 ?? null,
    matchesExpectedDriverBundle: expectedDriverBundleSha256
      ? driverBundleSha256 === expectedDriverBundleSha256
      : null,
    image: JSON.parse(run("docker", ["image", "inspect", image])),
    buildMs,
  };
  writeFileSync(join(output, "provenance.json"), JSON.stringify(provenance, null, 2));
  console.log(
    `Production driver bundle SHA256: ${driverBundleSha256}. Expected bundle match: ${provenance.matchesExpectedDriverBundle}.`,
  );
  console.log(
    "Running actual Chrome with network none, 2 CPUs, 1024 MiB. Runtime deadline: 4 minutes.",
  );
  try {
    const result = spawnSync(
      "docker",
      [
        "run",
        "--platform=linux/amd64",
        "--name",
        name,
        "--network",
        "none",
        "--cpus",
        "2",
        "--memory",
        "1024m",
        "--memory-swap",
        "1024m",
        "--env",
        `NAP_CHROME_SMOKE_FAULT=${fault ?? ""}`,
        image,
      ],
      { encoding: "utf8", timeout: 250000, killSignal: "SIGKILL", maxBuffer: 32_000_000 },
    );
    writeFileSync(join(output, "run.log"), `${result.stdout ?? ""}${result.stderr ?? ""}`);
    console.log(result.stdout);
    assert.equal(
      result.status,
      0,
      `Docker smoke failed. Read ${join(output, "failure.json")} and run.log. ${result.error ?? ""}`,
    );
  } finally {
    run("docker", ["cp", `${name}:/evidence/.`, output]);
    writeFileSync(join(output, "container.json"), run("docker", ["inspect", name]));
  }
  console.log(`Evidence: ${output}. Total elapsed: ${Date.now() - started} ms.`);
} finally {
  cleanup();
}
